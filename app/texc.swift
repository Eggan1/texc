// texc.swift: the native Mac shell for texc (AppKit + WebKit).
// One window = one WKWebView + one `texc.py gui [FOLDER] --app` child process.
// Contract: docs/ARCHITECTURE.md (shell) and (automation hook). Built by app/build.sh.
//
// Hidden switches (testing / build only):
//   --render-icon DIR        draw the app icon as an .iconset into DIR and exit (build.sh uses it)
//   --server-cmd CMD         (or env TEXC_SERVER_CMD) run `CMD gui [PATH] --app` through /bin/sh
//                            instead of `TexcPython TexcHome/texc.py gui [PATH] --app`
//   --automation DIR         (or env TEXC_AUTOMATION_DIR) the test hook
//   --config-dir DIR         passed to servers as TEXC_CONFIG_DIR; Open Recent reads DIR/recent.json
//   --folder PATH            open PATH at launch (repeatable)

import AppKit
import Darwin
import WebKit

// MARK: - Small helpers

/// `~` expansion; relative paths are taken relative to the home folder; `.`/`..` are folded.
func expandPath(_ raw: String) -> String {
    var p = (raw.trimmingCharacters(in: .whitespacesAndNewlines) as NSString).expandingTildeInPath
    if !p.hasPrefix("/") { p = (NSHomeDirectory() as NSString).appendingPathComponent(p) }
    return (p as NSString).standardizingPath
}

/// realpath(3): the same canonical form Python's os.path.realpath gives (keeps /private/…).
func realPath(_ p: String) -> String? {
    guard let r = Darwin.realpath(p, nil) else { return nil }
    defer { free(r) }
    return String(cString: r)
}

func abbreviateHome(_ p: String) -> String {
    let home = NSHomeDirectory()
    if p == home { return "~" }
    if p.hasPrefix(home + "/") { return "~" + p.dropFirst(home.count) }
    return p
}

func htmlEscape(_ s: String) -> String {
    s.replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
        .replacingOccurrences(of: "\"", with: "&quot;")
}

func orNull<T>(_ v: T?) -> Any { v.map { $0 as Any } ?? NSNull() }

/// Turns whatever WebKit or our code produced into something JSONSerialization accepts.
func jsonSafe(_ v: Any?) -> Any {
    guard let v = v else { return NSNull() }
    if v is NSNull { return v }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n }
    if let d = v as? Date { return ISO8601DateFormatter().string(from: d) }
    if let a = v as? [Any] { return a.map { jsonSafe($0) } }
    if let d = v as? [String: Any] { return d.mapValues { jsonSafe($0) } }
    if let d = v as? NSDictionary {
        var out: [String: Any] = [:]
        for (k, val) in d { out[String(describing: k)] = jsonSafe(val) }
        return out
    }
    return String(describing: v)
}

func writeJSONAtomically(_ obj: Any, to url: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(getpid()).tmp")
    try data.write(to: tmp)
    if rename(tmp.path, url.path) != 0 {
        let code = errno
        try? FileManager.default.removeItem(at: tmp)
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
    }
}

func describeError(_ e: Error) -> String {
    let ns = e as NSError
    if let m = ns.userInfo["WKJavaScriptExceptionMessage"] as? String { return m }
    return ns.localizedDescription
}

let externalSchemes: Set<String> = ["http", "https", "mailto"]

// MARK: - Launch options and bundle configuration

struct LaunchOptions {
    var automationDir: String?
    var configDir: String?          // explicit --config-dir (also exported to servers)
    var folders: [String] = []
    var serverCmd: String?
    var renderIconDir: String?

    static func parse(_ argv: [String], env: [String: String]) -> LaunchOptions {
        var o = LaunchOptions()
        var i = 1
        while i < argv.count {
            let a = argv[i]
            var key = a
            var inline: String?
            if a.hasPrefix("--"), let eq = a.firstIndex(of: "=") {
                key = String(a[..<eq])
                inline = String(a[a.index(after: eq)...])
            }
            func value() -> String? {
                if let v = inline { return v }
                if i + 1 < argv.count { i += 1; return argv[i] }
                return nil
            }
            switch key {
            case "--automation": o.automationDir = value()
            case "--config-dir": o.configDir = value()
            case "--folder": if let v = value() { o.folders.append(v) }
            case "--server-cmd": o.serverCmd = value()
            case "--render-icon": o.renderIconDir = value()
            default: break   // -psn_…, -NSDocumentRevisionsDebugMode … and anything else
            }
            i += 1
        }
        if o.automationDir == nil, let d = env["TEXC_AUTOMATION_DIR"], !d.isEmpty { o.automationDir = d }
        if o.serverCmd == nil, let c = env["TEXC_SERVER_CMD"], !c.isEmpty { o.serverCmd = c }
        o.automationDir = o.automationDir.map(expandPath)
        o.configDir = o.configDir.map(expandPath)
        return o
    }
}

enum Config {
    static var info: [String: Any] { Bundle.main.infoDictionary ?? [:] }
    static func string(_ key: String) -> String? {
        guard let s = info[key] as? String, !s.isEmpty else { return nil }
        return s
    }
    static var home: String { string("TexcHome") ?? (NSHomeDirectory() + "/.local/share/texc") }
    static var buildPath: String { string("TexcPath") ?? "" }
    static var python: String { string("TexcPython") ?? "/usr/bin/python3" }
    static var logDir: URL {
        URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/texc", isDirectory: true)
    }
}

// MARK: - Server child process

/// One `texc.py gui … --app` child. stdin is a pipe we keep open (EOF = shut down), stdout is read
/// until the TEXC_READY / TEXC_ERROR line (then drained into the log), stderr goes to the log file.
/// Callbacks run on the main queue.
final class ServerProcess: @unchecked Sendable {
    let process = Process()
    let stdinPipe = Pipe()
    let stdoutPipe = Pipe()
    let logURL: URL
    private let logHandle: FileHandle?
    private let lock = NSLock()
    private var buffer = Data()
    private var sawHandshake = false
    private var started = false
    private(set) var hasExited = false
    private var exitWaiters: [() -> Void] = []
    var onHandshake: ((String) -> Void)?
    var onExit: ((Int32) -> Void)?
    var pid: Int32 { process.processIdentifier }

    /// Servers being stopped stay referenced here until they exit.
    nonisolated(unsafe) static var stopping: [ObjectIdentifier: ServerProcess] = [:]

    init(executable: String, arguments: [String], environment: [String: String], logURL: URL) {
        self.logURL = logURL
        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        logHandle = try? FileHandle(forWritingTo: logURL)
        logHandle?.seekToEndOfFile()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = environment
        process.currentDirectoryURL = URL(fileURLWithPath: "/")   // never a folder with a stray main.tex
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = logHandle ?? FileHandle.nullDevice
    }

    func start() throws {
        let cmdline = ([process.executableURL?.path ?? "?"] + (process.arguments ?? [])).joined(separator: " ")
        logHandle?.write("=== texc.app \(Date()) pid \(getpid()): \(cmdline)\n".data(using: .utf8)!)
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { h.readabilityHandler = nil; return }
            self?.consume(data)
        }
        process.terminationHandler = { [weak self] p in
            let status = p.terminationStatus
            DispatchQueue.main.async { self?.didExit(status) }
        }
        try process.run()
        started = true
    }

    /// Background queue (readabilityHandler). The lock also covers the main-queue hand-off, so
    /// didExit can tell whether the handshake callback is already queued ahead of it.
    private func consume(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        if sawHandshake { logHandle?.write(data); return }
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            let line = String(decoding: lineData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("TEXC_READY") || line.hasPrefix("TEXC_ERROR") {
                sawHandshake = true
                DispatchQueue.main.async { [weak self] in self?.onHandshake?(line) }
                if !buffer.isEmpty { logHandle?.write(buffer); buffer.removeAll() }
                return
            }
            logHandle?.write(lineData + Data([0x0A]))
        }
        if buffer.count > 1 << 20 { logHandle?.write(buffer); buffer.removeAll() }
    }

    private func didExit(_ status: Int32) {
        lock.lock()
        let saw = sawHandshake
        lock.unlock()
        let finish: () -> Void = { [weak self] in
            guard let self = self, !self.hasExited else { return }
            self.hasExited = true
            self.onExit?(status)
            let waiters = self.exitWaiters
            self.exitWaiters = []
            waiters.forEach { $0() }
        }
        // Handshake already queued: run after it. Not seen yet: give a late stdout line a moment.
        if saw { DispatchQueue.main.async(execute: finish) } else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: finish) }
    }

    func whenExited(_ fn: @escaping () -> Void) {
        if hasExited || !started { fn() } else { exitWaiters.append(fn) }
    }

    /// Close stdin (EOF), SIGTERM, then SIGKILL after `grace` seconds. Never blocks.
    func stop(grace: TimeInterval = 3, then done: (() -> Void)? = nil) {
        onHandshake = nil
        onExit = nil
        if let done = done { whenExited(done) }
        guard started, !hasExited else { return }
        let key = ObjectIdentifier(self)
        ServerProcess.stopping[key] = self
        whenExited { ServerProcess.stopping[key] = nil }
        try? stdinPipe.fileHandleForWriting.close()
        if process.isRunning { kill(process.processIdentifier, SIGTERM) }
        DispatchQueue.main.asyncAfter(deadline: .now() + grace) { [self] in
            if self.process.isRunning { kill(self.process.processIdentifier, SIGKILL) }
        }
    }

    /// Last resort at app exit.
    func killNow() {
        if started, process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }

    static func tail(of logURL: URL, maxBytes: Int = 8000, maxLines: Int = 60) -> String {
        guard let h = try? FileHandle(forReadingFrom: logURL) else { return "" }
        defer { try? h.close() }
        let size = h.seekToEndOfFile()
        h.seek(toFileOffset: size > UInt64(maxBytes) ? size - UInt64(maxBytes) : 0)
        let text = String(decoding: h.readDataToEndOfFile(), as: UTF8.self)
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        return lines.suffix(maxLines).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Bridge proxy (breaks the WKUserContentController → handler retain cycle)

@MainActor
final class BridgeProxy: NSObject, WKScriptMessageHandlerWithReply {
    weak var owner: TexcWindow?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        guard let owner = owner else { replyHandler(nil, "This window is closing."); return }
        owner.handleBridge(message, reply: replyHandler)
    }
}

// MARK: - Window

enum WinState: String { case starting, ready, failed }

enum OpenOutcome {
    case opened(TexcWindow), focused(TexcWindow), cancelled, failed(String)
}

let errorRecorderJS = """
(function () {
  if (window.__texcErrors) return;
  var errs = window.__texcErrors = [];
  function push(s) { try { if (errs.length < 500) errs.push(String(s).slice(0, 4000)); } catch (_) {} }
  function fmt(x) {
    try {
      if (x instanceof Error) return x.message + (x.stack ? "\\n" + x.stack : "");
      if (typeof x === "string") return x;
      return JSON.stringify(x);
    } catch (_) { return String(x); }
  }
  window.addEventListener("error", function (e) {
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) { push("resource failed to load: " + (t.tagName || "") + " " + (t.src || t.href)); return; }
    push("error: " + (e.message || "") + (e.filename ? " (" + e.filename + ":" + e.lineno + ":" + e.colno + ")" : "") +
         (e.error && e.error.stack ? "\\n" + e.error.stack : ""));
  }, true);
  window.addEventListener("unhandledrejection", function (e) { push("unhandledrejection: " + fmt(e.reason)); });
  var orig = console.error;
  console.error = function () {
    push("console.error: " + Array.prototype.map.call(arguments, fmt).join(" "));
    return orig.apply(console, arguments);
  };
})();
"""

// MARK: - Silent windows (automation)

/// In automation mode (tests) a window lives off every screen, takes no clicks, never beeps and
/// never goes full screen or minimises, so a test run can't pop up over the user's work. The web
/// view's occlusion detection is turned off (see TexcWindow.init) so pages still render.
final class TexcNSWindow: NSWindow {
    var silent = false

    static func offscreenOrigin() -> NSPoint {
        let all = NSScreen.screens.reduce(NSRect.null) { $0.union($1.frame) }
        let base = all.isNull ? NSRect(x: 0, y: 0, width: 1440, height: 900) : all
        return NSPoint(x: base.maxX + 4000, y: base.minY)
    }

    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        silent ? frameRect : super.constrainFrameRect(frameRect, to: screen)
    }
    override func setFrame(_ frameRect: NSRect, display flag: Bool) {
        super.setFrame(silent ? NSRect(origin: TexcNSWindow.offscreenOrigin(), size: frameRect.size) : frameRect, display: flag)
    }
    override func setFrame(_ frameRect: NSRect, display displayFlag: Bool, animate animateFlag: Bool) {
        if silent { setFrame(frameRect, display: displayFlag) } else { super.setFrame(frameRect, display: displayFlag, animate: animateFlag) }
    }
    override func setFrameOrigin(_ point: NSPoint) {
        super.setFrameOrigin(silent ? TexcNSWindow.offscreenOrigin() : point)
    }
    override func setFrameTopLeftPoint(_ point: NSPoint) {
        if silent { setFrameOrigin(point) } else { super.setFrameTopLeftPoint(point) }
    }
    override func center() {
        if silent { setFrameOrigin(.zero) } else { super.center() }
    }
    override func toggleFullScreen(_ sender: Any?) { if !silent { super.toggleFullScreen(sender) } }
    override func performMiniaturize(_ sender: Any?) { if !silent { super.performMiniaturize(sender) } }
    override func miniaturize(_ sender: Any?) { if !silent { super.miniaturize(sender) } }
    override func performZoom(_ sender: Any?) { if !silent { super.performZoom(sender) } }
    override func zoom(_ sender: Any?) { if !silent { super.zoom(sender) } }
    override func noResponder(for eventSelector: Selector) { if !silent { super.noResponder(for: eventSelector) } }
}

@MainActor
final class TexcWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private static var nextID = 1
    static let zoomSteps: [CGFloat] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]

    let id: Int
    let window: NSWindow
    let webView: WKWebView
    private let bridge = BridgeProxy()
    private weak var app: AppController?

    private(set) var state: WinState = .starting
    private(set) var mode = "lobby"              // "lobby" | "project"
    private(set) var folder: String?             // realpath of the project folder
    private(set) var mainFile: String?
    private(set) var pageName: String?
    private var target: String?                  // what the server was started with; nil = lobby
    private var query: String?                   // one-shot query for the first load, e.g. "new=1"
    private(set) var serverURL: URL?
    private var origin: (scheme: String, host: String, port: Int)?
    private(set) var serverPid: Int32?
    private(set) var ownsServer = false
    private var server: ServerProcess?
    private var lastLog: URL?
    private var handshakeTimeout: DispatchWorkItem?
    private(set) var lastError: String?
    private var titleObservation: NSKeyValueObservation?
    private var allowClose = false
    private var closeInFlight = false
    private var closeWaiters: [(Bool) -> Void] = []
    private var loadWaiters: [(String?) -> Void] = []
    private var downloads: [ObjectIdentifier: URL] = [:]
    var usesAutosave = false
    private(set) var jsDialogOpen = false
    private(set) var isClosed = false

    init(app: AppController, automation: Bool) {
        id = TexcWindow.nextID
        TexcWindow.nextID += 1
        self.app = app

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        let ucc = WKUserContentController()
        ucc.addUserScript(WKUserScript(source: "window.texcNative = {version: 1, platform: \"mac\"};",
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if automation {
            ucc.addUserScript(WKUserScript(source: errorRecorderJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        ucc.addScriptMessageHandler(bridge, contentWorld: .page, name: "texc")
        config.userContentController = ucc
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: config)

        let frame = TexcWindow.defaultContentRect()
        let win = TexcNSWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable],
                               backing: .buffered, defer: false)
        window = win
        super.init()
        bridge.owner = self

        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.tabbingMode = .disallowed
        if automation {
            win.silent = true
            win.setFrameOrigin(.zero)            // off every screen (TexcNSWindow keeps it there)
            win.ignoresMouseEvents = true
            win.hasShadow = false
            win.animationBehavior = .none
            win.isExcludedFromWindowsMenu = true
            win.collectionBehavior = [.transient, .ignoresCycle]
            // An off-screen window counts as occluded, and WebKit would stop rendering and throttle
            // timers. Private WKWebView switch (KVC finds _setWindowOcclusionDetectionEnabled:).
            if webView.responds(to: NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")) {
                webView.setValue(false, forKey: "windowOcclusionDetectionEnabled")
            }
        } else {
            window.collectionBehavior.insert(.fullScreenPrimary)
        }
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = .black
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 900, height: 560)
        window.title = "texc"
        window.delegate = self

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.underPageBackgroundColor = .black
        if webView.responds(to: NSSelectorFromString("_setDrawsBackground:")) {
            webView.setValue(false, forKey: "drawsBackground")   // no white flash between loads
        }
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView

        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.refreshTitle() }
        }
    }

    static func defaultContentRect() -> NSRect {
        let vis = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let w = min(1440, vis.width - 40)
        let h = min(900, vis.height - 60)
        return NSRect(x: vis.midX - w / 2, y: vis.midY - h / 2, width: max(w, 600), height: max(h, 400))
    }

    // MARK: Server lifecycle

    /// Starts (or replaces) this window's server. `target` nil = lobby; otherwise an absolute folder or .tex path.
    func start(target: String?, query: String? = nil) {
        stopServer()
        self.target = target
        self.query = query
        state = .starting
        lastError = nil
        serverURL = nil
        origin = nil
        serverPid = nil
        ownsServer = false
        if let t = target {
            mode = "project"
            var isDir: ObjCBool = false
            FileManager.default.fileExists(atPath: t, isDirectory: &isDir)
            folder = isDir.boolValue ? t : (t as NSString).deletingLastPathComponent
            mainFile = isDir.boolValue ? nil : (t as NSString).lastPathComponent
            pageName = (folder! as NSString).lastPathComponent
        } else {
            mode = "lobby"
            folder = nil
            mainFile = nil
            pageName = nil
        }
        updateRepresentedURL()
        showLoadingPage()
        guard let app = app else { return }

        let spec = app.serverCommand(target: target)
        let log = app.newLogURL(windowID: id)
        lastLog = log
        let proc = ServerProcess(executable: spec.executable, arguments: spec.arguments,
                                 environment: app.childEnvironment, logURL: log)
        proc.onHandshake = { [weak self, weak proc] line in
            guard let self = self, let proc = proc, self.server === proc else { return }
            self.handleHandshake(line)
        }
        proc.onExit = { [weak self, weak proc] status in
            guard let self = self, let proc = proc, self.server === proc else { return }
            self.serverExited(status)
        }
        server = proc
        do {
            try proc.start()
        } catch {
            server = nil
            fail(title: "texc couldn't start", message: "Couldn't run \(spec.executable): \(error.localizedDescription)")
            return
        }
        serverPid = proc.pid
        ownsServer = true
        let work = DispatchWorkItem { [weak self, weak proc] in
            guard let self = self, let proc = proc, self.server === proc, self.serverURL == nil else { return }
            self.server = nil
            proc.stop(grace: 1)
            self.fail(title: self.startFailureTitle, message: "The texc server didn't answer within 20 seconds.")
        }
        handshakeTimeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: work)
    }

    private var startFailureTitle: String { target == nil ? "texc couldn't start" : "texc couldn't open this folder" }

    private func handleHandshake(_ line: String) {
        handshakeTimeout?.cancel()
        handshakeTimeout = nil
        var obj: [String: Any] = [:]
        if let brace = line.firstIndex(of: "{"),
           let parsed = (try? JSONSerialization.jsonObject(with: Data(line[brace...].utf8))) as? [String: Any] {
            obj = parsed
        }
        if line.hasPrefix("TEXC_ERROR") {
            let msg = (obj["error"] as? String) ?? "The texc server reported an error."
            if let s = server { server = nil; s.stop(grace: 2) }
            fail(title: startFailureTitle, message: msg)
            return
        }
        guard let urlString = obj["url"] as? String, let url = URL(string: urlString), let host = url.host else {
            if let s = server { server = nil; s.stop(grace: 1) }
            fail(title: startFailureTitle, message: "The texc server sent an unreadable handshake: \(line)")
            return
        }
        if let m = obj["mode"] as? String, m == "lobby" || m == "project" { mode = m }
        if mode == "project", let f = obj["folder"] as? String, !f.isEmpty {
            folder = f
            pageName = (f as NSString).lastPathComponent
        } else if mode == "lobby" {
            folder = nil
            pageName = nil
        }
        mainFile = obj["main"] as? String
        if (obj["already_open"] as? Bool) == true {
            // Another texc already serves this folder; our child exits by itself. Not ours to kill.
            if let s = server { server = nil; s.onExit = nil; s.onHandshake = nil; s.whenExited {} }
            ownsServer = false
            serverPid = (obj["pid"] as? NSNumber)?.int32Value
        } else {
            ownsServer = true
            if let p = (obj["pid"] as? NSNumber)?.int32Value { serverPid = p }
        }
        serverURL = url
        origin = ((url.scheme ?? "http").lowercased(), host.lowercased(), url.port ?? 80)
        updateRepresentedURL()
        refreshTitle()
        var loadURL = url
        if let q = query, var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            comps.percentEncodedQuery = q
            loadURL = comps.url ?? url
        }
        query = nil
        webView.load(URLRequest(url: loadURL))
    }

    private func serverExited(_ status: Int32) {
        server = nil
        handshakeTimeout?.cancel()
        handshakeTimeout = nil
        if isClosed || state == .failed { return }
        if serverURL == nil {
            fail(title: startFailureTitle, message: "The texc server exited (status \(status)) before it was ready.")
        } else {
            fail(title: "texc stopped", message: "The texc server for this window stopped (status \(status)).")
        }
    }

    private func stopServer() {
        handshakeTimeout?.cancel()
        handshakeTimeout = nil
        if let s = server { server = nil; s.stop(grace: 6) }
    }

    /// Hands the running child to the caller (quit path) so it can wait for it.
    func detachServer() -> ServerProcess? {
        handshakeTimeout?.cancel()
        let s = server
        server = nil
        s?.onExit = nil
        s?.onHandshake = nil
        return s
    }

    func respawn() { start(target: target) }

    private func fail(title: String, message: String) {
        state = .failed
        lastError = message
        origin = nil
        let tail = lastLog.map { ServerProcess.tail(of: $0) } ?? ""
        showErrorPage(title: title, message: message, tail: tail)
        flushLoadWaiters(error: message)
    }

    // MARK: Pages owned by the shell

    private func showLoadingPage() {
        let what = target.map { "Opening " + htmlEscape(($0 as NSString).lastPathComponent) + "…" } ?? "Starting texc…"
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><title>texc</title><style>
        html,body{margin:0;height:100%;background:#000;color:#6b6b6b;font:13px -apple-system,BlinkMacSystemFont,sans-serif}
        body{display:flex;align-items:center;justify-content:center}
        .m{opacity:0;animation:f .3s .7s forwards}@keyframes f{to{opacity:1}}
        </style></head><body><div class="m">\(what)</div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func showErrorPage(title: String, message: String, tail: String) {
        let name = pageName.map { htmlEscape($0) + " — texc" } ?? "texc"
        let lobbyLink = mode == "project" ? "<a class=\"sec\" href=\"texc-app://lobby\">Welcome screen</a>" : ""
        let pre = tail.isEmpty ? "" : "<pre>\(htmlEscape(tail))</pre>"
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><title>\(name)</title><style>
        html,body{margin:0;background:#000;color:#ececec;font:13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}
        main{max-width:760px;margin:12vh auto 0;padding:0 32px}
        h1{font-size:20px;font-weight:600;margin:0 0 8px}
        p{color:#a3a3a3;margin:0 0 16px}
        pre{background:#0b0b0b;border:1px solid #262626;border-radius:10px;padding:12px 14px;max-height:42vh;overflow:auto;
            font:12px/1.5 "SF Mono",Menlo,monospace;color:#d6d6d6;white-space:pre-wrap;word-break:break-word;margin:0 0 20px}
        a.btn{display:inline-block;background:#fff;color:#000;border-radius:8px;padding:7px 16px;text-decoration:none;font-weight:500}
        a.sec{color:#a3a3a3;margin-left:16px;text-decoration:none} a.sec:hover{color:#ececec}
        </style></head><body><main>
        <h1 id="title">\(htmlEscape(title))</h1>
        <p id="message">\(htmlEscape(message))</p>
        \(pre)
        <div><a class="btn" id="reload" href="texc-app://reload">Reload</a><a class="sec" href="texc-app://log">Show log</a>\(lobbyLink)</div>
        </main></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func handleInternal(_ url: URL) {
        switch url.host ?? "" {
        case "reload": respawn()
        case "lobby": start(target: nil)
        case "log": if let l = lastLog { app?.openFile(l) }
        default: break
        }
    }

    func reloadPage() {
        if state == .failed { respawn(); return }
        guard serverURL != nil else { return }
        // A reload drops in-memory state the page can't save on its own (typing in a file with a
        // pending AI edit): ask the page first, as closing does.
        askBeforeClose { [weak self] ok in
            guard let self = self, ok, !self.isClosed else { return }
            // No server of ours (it died, or this window shows another texc's server that may have
            // died): start over, which comes back to that server if it is still alive.
            if self.server == nil { self.respawn() } else { self.webView.reload() }
        }
    }

    func reloadLobbyWithNewProject() {
        guard mode == "lobby", let url = serverURL, var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        comps.percentEncodedQuery = "new=1"
        if let u = comps.url { webView.load(URLRequest(url: u)) }
    }

    // MARK: Title, proxy icon, zoom

    func refreshTitle() {
        if let t = webView.title, !t.isEmpty { window.title = t }
        else if let n = pageName { window.title = "\(n) — texc" }
        else { window.title = "texc" }
    }

    private func updateRepresentedURL() {
        if mode == "project", let f = folder {
            window.representedURL = URL(fileURLWithPath: f, isDirectory: true)
        } else {
            window.representedURL = nil
        }
    }

    func zoom(_ direction: Int) {
        let cur = webView.pageZoom
        let next: CGFloat
        if direction == 0 { next = 1 }
        else if direction > 0 { next = TexcWindow.zoomSteps.first { $0 > cur + 0.001 } ?? 3 }
        else { next = TexcWindow.zoomSteps.last { $0 < cur - 0.001 } ?? 0.5 }
        webView.pageZoom = next
    }

    // MARK: Origin checks

    func isServerURL(_ url: URL) -> Bool {
        guard let o = origin else { return false }
        return (url.scheme ?? "").lowercased() == o.scheme && (url.host ?? "").lowercased() == o.host && (url.port ?? 80) == o.port
    }

    private func isServerOrigin(_ so: WKSecurityOrigin) -> Bool {
        guard let o = origin else { return false }
        let port = so.port == 0 ? 80 : so.port
        return so.protocol.lowercased() == o.scheme && so.host.lowercased() == o.host && port == o.port
    }

    private var pageIsServer: Bool { webView.url.map(isServerURL) ?? false }

    // MARK: Shell → page

    /// Calls T.host._native(cmd, arg). Completion gets the page's value, or nil for null /
    /// not handled / failure / timeout. While a JS dialog is up the timeout waits for the user.
    /// `patient`: when the timeout passes, ping the page; if it still answers it is alive and most
    /// likely showing its own in-page confirm ("Discard the AI edits you haven't reviewed?"), so keep
    /// waiting for the user instead of answering for them. Only a page that no longer answers times out.
    func callPage(_ cmd: String, _ arg: Any? = nil, timeout: TimeInterval? = nil, patient: Bool = false,
                  completion: @escaping (Any?) -> Void) {
        guard state == .ready, pageIsServer else { completion(nil); return }
        var done = false
        let finish: (Any?) -> Void = { v in
            if done { return }
            done = true
            completion(v)
        }
        let js = "const r = await (window.T && T.host && T.host._native ? T.host._native(cmd, arg) : null); return r === undefined ? null : r;"
        webView.callAsyncJavaScript(js, arguments: ["cmd": cmd, "arg": arg ?? NSNull()], in: nil, in: .page) { result in
            switch result {
            case .success(let v): finish(v is NSNull ? nil : v)
            case .failure(let e):
                NSLog("texc: page command %@ failed: %@", cmd, describeError(e))
                finish(nil)
            }
        }
        if let t = timeout {
            weak let weakSelf = self          // nothing in arm may capture self: a closed window must go away
            func arm(_ delay: TimeInterval) {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    if done { return }
                    guard let w = weakSelf, !w.isClosed else { finish(nil); return }
                    if w.jsDialogOpen { arm(t); return }
                    guard patient else { finish(nil); return }
                    w.pingPage { alive in
                        if done { return }
                        if alive { arm(min(t, 30)) } else { finish(nil) }
                    }
                }
            }
            arm(t)
        }
    }

    /// true when the page's JS still runs (answers within 3 s).
    private func pingPage(_ completion: @escaping (Bool) -> Void) {
        guard pageIsServer else { completion(false); return }
        var answered = false
        webView.callAsyncJavaScript("return 1;", arguments: [:], in: nil, in: .page) { result in
            if answered { return }
            answered = true
            if case .success = result { completion(true) } else { completion(false) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            if answered { return }
            answered = true
            completion(false)
        }
    }

    /// beforeClose: `false` cancels. The page may be showing a confirm (unreviewed AI edits, the
    /// editor's changed-on-disk dialog), so it gets 120 s, and after that it is waited for as long as it
    /// still answers. Only no page, or a page that has stopped answering, counts as yes.
    func askBeforeClose(_ completion: @escaping (Bool) -> Void) {
        var answered = false
        callPage("beforeClose", nil, timeout: 120, patient: true) { v in
            answered = true
            completion(!((v as? Bool) == false))
        }
        // Still waiting after half a second means the page is asking the user something: show it,
        // or a confirm in a hidden, minimised or covered window makes Quit look stuck.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self, !answered, !self.isClosed, let app = self.app, !app.isAutomation else { return }
            NSApp.unhide(nil)
            app.focus(self)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func closeFolder(_ completion: ((Bool) -> Void)? = nil) {
        guard mode == "project" || state == .failed else { completion?(true); return }
        askBeforeClose { [weak self] ok in
            guard let self = self, !self.isClosed, ok else { completion?(false); return }
            self.start(target: nil)
            completion?(true)
        }
    }

    // MARK: Closing

    /// The normal close path (menu, automation): beforeClose, then close. Completion: closed?
    func requestClose(_ completion: ((Bool) -> Void)? = nil) {
        if isClosed { completion?(true); return }
        if let c = completion { closeWaiters.append(c) }
        _ = windowShouldClose(window)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if allowClose { return true }
        if !closeInFlight {
            closeInFlight = true
            askBeforeClose { [weak self] ok in
                guard let self = self else { return }
                self.closeInFlight = false
                if ok && !self.isClosed {
                    self.allowClose = true
                    self.window.close()
                }
                let waiters = self.closeWaiters
                self.closeWaiters = []
                waiters.forEach { $0(ok) }
            }
        }
        return false
    }

    func windowWillClose(_ notification: Notification) {
        isClosed = true
        if usesAutosave { window.setFrameAutosaveName(""); usesAutosave = false }   // the next window takes it
        titleObservation = nil
        stopServer()
        webView.stopLoading()
        webView.configuration.userContentController.removeAllScriptMessageHandlers()
        flushLoadWaiters(error: "The window was closed.")
        app?.windowDidClose(self)
    }

    // MARK: Waiting for loads (automation)

    func whenLoaded(timeout: TimeInterval, _ cb: @escaping (String?) -> Void) {
        if state == .ready && pageIsServer && !webView.isLoading { cb(nil); return }
        if state == .failed { cb(lastError ?? "The window failed to load."); return }
        var fired = false
        let once: (String?) -> Void = { e in
            if fired { return }
            fired = true
            cb(e)
        }
        loadWaiters.append(once)
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { once("Timed out waiting for the page to load.") }
    }

    private func flushLoadWaiters(error: String?) {
        let waiters = loadWaiters
        loadWaiters = []
        waiters.forEach { $0(error) }
    }

    // MARK: Bridge (page → shell)

    func handleBridge(_ message: WKScriptMessage, reply: @escaping @MainActor (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, isServerOrigin(message.frameInfo.securityOrigin) else {
            reply(nil, "texc only accepts messages from this window's own server.")
            return
        }
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String, let app = app else {
            reply(nil, "texc: malformed message")
            return
        }
        switch cmd {
        case "pickFolder":
            app.pickFolder(prompt: body["prompt"] as? String, for: self) { path in reply(orNull(path), nil) }
        case "openFolder":
            guard let path = body["path"] as? String, !path.isEmpty else { reply(nil, "openFolder needs a path."); return }
            app.openFolder(path, newWindow: (body["newWindow"] as? Bool) ?? false, from: self) { outcome in
                switch outcome {
                case .opened: reply("opened", nil)
                case .focused: reply("focused", nil)
                case .cancelled: reply("cancelled", nil)
                case .failed(let msg): reply(nil, msg)
                }
            }
        case "closeFolder":
            closeFolder { ok in reply(ok, nil) }
        case "newWindow":
            if let p = body["path"] as? String, !p.isEmpty {
                app.openFolder(p, newWindow: true, from: self) { app.reportFailure($0) }
            } else {
                app.newLobbyWindow()
            }
            reply(true, nil)
        case "newProject":
            app.newLobbyWindow(query: "new=1")
            reply(true, nil)
        case "openExternal":
            guard let s = body["url"] as? String, let u = URL(string: s), externalSchemes.contains((u.scheme ?? "").lowercased()) else {
                reply(false, nil)
                return
            }
            app.openExternal(u)
            reply(true, nil)
        case "reveal":
            guard let p = body["path"] as? String, !p.isEmpty else { reply(nil, "reveal needs a path."); return }
            let abs = p.hasPrefix("/") || p.hasPrefix("~") || folder == nil ? expandPath(p) : ((folder! as NSString).appendingPathComponent(p))
            app.reveal(abs)
            reply(true, nil)
        case "state":
            if let n = body["name"] as? String, !n.isEmpty { pageName = n }
            if folder == nil, mode == "project", let f = body["folder"] as? String, !f.isEmpty { folder = f }
            updateRepresentedURL()
            refreshTitle()
            reply(true, nil)
        default:
            reply(nil, "texc: unknown command \(cmd)")
        }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
        guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
        let scheme = (url.scheme ?? "").lowercased()
        if scheme == "texc-app" {
            decisionHandler(.cancel)
            if !pageIsServer { handleInternal(url) }      // only the shell's own error page uses these links
            return
        }
        // New-window requests (target=_blank) have no target frame: createWebViewWith opens them.
        guard let frame = navigationAction.targetFrame else { decisionHandler(.allow); return }
        if !frame.isMainFrame { decisionHandler(.allow); return }
        if scheme == "about" || isServerURL(url) { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        if externalSchemes.contains(scheme) { app?.openExternal(url) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        if let http = navigationResponse.response as? HTTPURLResponse,
           let cd = http.value(forHTTPHeaderField: "Content-Disposition"), cd.lowercased().contains("attachment") {
            decisionHandler(.download)
            return
        }
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard pageIsServer else { return }
        if state == .starting { state = .ready }
        window.makeFirstResponder(webView)
        refreshTitle()
        flushLoadWaiters(error: nil)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && (ns.code == 101 || ns.code == 102) { return }   // policy change / download
        if state == .starting && serverURL != nil && server != nil {
            fail(title: startFailureTitle, message: "The page didn't load: \(ns.localizedDescription)")
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if state == .ready, let u = serverURL { webView.load(URLRequest(url: u)) }
    }

    // MARK: WKDownloadDelegate

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping @MainActor (URL?) -> Void) {
        guard let app = app else { completionHandler(nil); return }
        app.runSavePanel(for: window, suggestedName: suggestedFilename) { [weak self] url in
            guard let url = url else { completionHandler(nil); return }
            if FileManager.default.fileExists(atPath: url.path) { try? FileManager.default.removeItem(at: url) }
            self?.downloads[ObjectIdentifier(download)] = url
            completionHandler(url)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        let url = downloads.removeValue(forKey: ObjectIdentifier(download))
        app?.record(["kind": "download", "ok": true, "path": orNull(url?.path)])
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let url = downloads.removeValue(forKey: ObjectIdentifier(download))
        app?.record(["kind": "download", "ok": false, "path": orNull(url?.path), "error": describeError(error)])
        NSLog("texc: download failed: %@", describeError(error))
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, externalSchemes.contains((url.scheme ?? "").lowercased()) {
            app?.openExternal(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        guard let app = app else { completionHandler(nil); return }
        app.runOpenPanel(for: window, configure: { p in
            p.allowsMultipleSelection = parameters.allowsMultipleSelection
            p.canChooseDirectories = parameters.allowsDirectories
            p.canChooseFiles = true
            p.resolvesAliases = true
        }, completion: { urls in completionHandler(urls) })
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        showDialog(alert) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        showDialog(alert) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        showDialog(alert) { r in completionHandler(r == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    private func showDialog(_ alert: NSAlert, _ done: @escaping (NSApplication.ModalResponse) -> Void) {
        alert.alertStyle = .informational
        jsDialogOpen = true
        NSLog("texc: window %d shows a JS dialog: %@", id, alert.messageText)
        alert.beginSheetModal(for: window) { [weak self] r in
            NSLog("texc: JS dialog answered with %d", r.rawValue)
            self?.jsDialogOpen = false
            done(r)
        }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
        decisionHandler(.prompt)
    }

    // MARK: Automation helpers

    func describe(front: TexcWindow?) -> [String: Any] {
        var d: [String: Any] = [
            "id": id, "title": window.title, "url": orNull(webView.url?.absoluteString), "mode": mode,
            "folder": orNull(folder), "main": orNull(mainFile), "serverPid": orNull(serverPid.map { Int($0) }),
            "ownsServer": ownsServer, "state": state.rawValue, "zoom": webView.pageZoom,
            "keyWindow": window.isKeyWindow || (NSApp.keyWindow == nil && front === self),
            "visible": window.isVisible, "appActive": NSApp.isActive,
        ]
        if let e = lastError { d["error"] = e }
        if let sheet = window.attachedSheet { d["sheet"] = TexcWindow.sheetText(sheet) }
        return d
    }

    static func sheetText(_ sheet: NSWindow) -> String {
        if sheet is NSOpenPanel { return "open panel" }
        if sheet is NSSavePanel { return "save panel" }
        var parts: [String] = []
        func walk(_ v: NSView) {
            if let t = v as? NSTextField, !t.isEditable, !t.stringValue.isEmpty { parts.append(t.stringValue) }
            v.subviews.forEach(walk)
        }
        if let cv = sheet.contentView { walk(cv) }
        return parts.joined(separator: " | ")
    }

    func evalForAutomation(_ js: String, timeout: TimeInterval, _ done: @escaping ([String: Any]) -> Void) {
        var fired = false
        let once: ([String: Any]) -> Void = { r in
            if fired { return }
            fired = true
            done(r)
        }
        let body = "const __texcResult = await (async () => {\n\(js)\n})();\nreturn __texcResult === undefined ? null : __texcResult;"
        webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let v): once(["ok": true, "result": jsonSafe(v)])
            case .failure(let e): once(["ok": false, "error": describeError(e)])
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { once(["ok": false, "error": "eval timed out after \(Int(timeout)) s"]) }
    }

    func snapshot(to path: String, _ done: @escaping ([String: Any]) -> Void) {
        webView.takeSnapshot(with: WKSnapshotConfiguration()) { image, error in
            guard let image = image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                done(["ok": false, "error": error.map(describeError) ?? "The snapshot failed."])
                return
            }
            let rep = NSBitmapImageRep(cgImage: cg)
            guard let png = rep.representation(using: .png, properties: [:]) else {
                done(["ok": false, "error": "Couldn't encode the PNG."])
                return
            }
            let url = URL(fileURLWithPath: expandPath(path))
            do {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try png.write(to: url)
                done(["ok": true, "path": url.path, "width": rep.pixelsWide, "height": rep.pixelsHigh])
            } catch {
                done(["ok": false, "error": error.localizedDescription])
            }
        }
    }
}

// MARK: - Application subclass (automation routing only)

/// In automation mode the app may sit in the background with no key window (the hook never
/// activates it). AppKit then drops key events and nil-targeted actions. This routes synthetic
/// key events to the window they name and nil-targeted actions to that window's responder chain.
/// Inert outside automation mode, and whenever a real key window exists.
final class TexcApplication: NSApplication {
    var automationRouting = false
    private weak var routingWindow: NSWindow?
    /// What the last synthetic keyDown did (reported by the automation `key` command).
    var lastRouting = ""

    // Tests must never hide or unhide the user's other apps (or this one: hidden pages stop rendering).
    override func hide(_ sender: Any?) { if !automationRouting { super.hide(sender) } }
    override func hideOtherApplications(_ sender: Any?) { if !automationRouting { super.hideOtherApplications(sender) } }
    override func unhideAllApplications(_ sender: Any?) { if !automationRouting { super.unhideAllApplications(sender) } }
    override func arrangeInFront(_ sender: Any?) { if !automationRouting { super.arrangeInFront(sender) } }

    override func sendEvent(_ event: NSEvent) {
        if automationRouting, event.type == .keyDown {
            lastRouting = "keyWindow=\(keyWindow.map { String(describing: type(of: $0)) } ?? "nil") target=\(window(withWindowNumber: event.windowNumber).map { String(describing: type(of: $0)) } ?? "nil")"
        }
        if automationRouting, keyWindow == nil, event.type == .keyDown || event.type == .keyUp,
           let w = window(withWindowNumber: event.windowNumber) {
            let previous = routingWindow
            routingWindow = w
            defer { routingWindow = previous }
            let isWebWindow = AppController.shared?.windows.contains { $0.window === w } ?? false
            if event.type == .keyDown,
               !isWebWindow || !event.modifierFlags.intersection([.command, .control]).isEmpty {
                if w.performKeyEquivalent(with: event) { lastRouting += " → window key equivalent"; return }
                // Sheets (JS alerts, panels): Return / Escape press the matching button, as AppKit would.
                if !isWebWindow, clickButton(in: w, matching: event) { lastRouting += " → sheet button"; return }
                if let menu = mainMenu, menu.performKeyEquivalent(with: event) { lastRouting += " → menu"; return }
            }
            if event.type == .keyDown { lastRouting += " → sendEvent" }
            w.sendEvent(event)
            return
        }
        super.sendEvent(event)
    }

    private func clickButton(in w: NSWindow, matching event: NSEvent) -> Bool {
        guard let key = event.charactersIgnoringModifiers, !key.isEmpty, let root = w.contentView else { return false }
        let relevant: NSEvent.ModifierFlags = [.command, .control, .option, .shift]
        let mods = event.modifierFlags.intersection(relevant)
        let isReturn = key == "\r" || key == "\u{3}"
        // Return presses the default button, which is how AppKit answers it in panels and alerts.
        if isReturn, mods.isEmpty, let b = w.defaultButtonCell?.controlView as? NSButton, b.isEnabled {
            b.performClick(nil)
            return true
        }
        var found: NSButton?
        var seen: [String] = []
        func walk(_ v: NSView) {
            if found != nil { return }
            if let b = v as? NSButton {
                seen.append("\(b.title)=\(b.keyEquivalent.unicodeScalars.map { String($0.value, radix: 16) }.joined(separator: ","))")
                let keyMatches = b.keyEquivalent == key || (isReturn && (b.keyEquivalent == "\r" || b.keyEquivalent == "\u{3}"))
                if b.isEnabled, !b.isHiddenOrHasHiddenAncestor, keyMatches, b.keyEquivalentModifierMask.intersection(relevant) == mods {
                    found = b
                    return
                }
            }
            v.subviews.forEach(walk)
        }
        walk(root)
        if isReturn && found == nil {
            // Last resort for alerts: the first enabled push button is the default one.
            func firstPush(_ v: NSView) -> NSButton? {
                if let b = v as? NSButton, b.isEnabled, !b.isHiddenOrHasHiddenAncestor, b.bezelStyle == .push || b.bezelStyle == .rounded { return b }
                for sub in v.subviews { if let b = firstPush(sub) { return b } }
                return nil
            }
            if w is NSPanel, mods.isEmpty, w.className.contains("Alert") { found = firstPush(root) }
        }
        guard let b = found else { lastRouting += " (buttons: \(seen.joined(separator: " ")))"; return false }
        b.performClick(nil)
        return true
    }

    override func sendAction(_ action: Selector, to target: Any?, from sender: Any?) -> Bool {
        if target == nil, automationRouting, keyWindow == nil, let t = fallbackTarget(for: action) {
            return super.sendAction(action, to: t, from: sender)
        }
        return super.sendAction(action, to: target, from: sender)
    }

    override func target(forAction action: Selector, to target: Any?, from sender: Any?) -> Any? {
        if target == nil, automationRouting, keyWindow == nil, let t = fallbackTarget(for: action) { return t }
        return super.target(forAction: action, to: target, from: sender)
    }

    private func fallbackTarget(for action: Selector) -> Any? {
        guard let w = routingWindow ?? AppController.shared?.frontWindow()?.window else { return nil }
        let start = w.attachedSheet ?? w
        var r: NSResponder? = start.firstResponder
        while let x = r {
            if x.responds(to: action) { return x }
            r = x.nextResponder
        }
        if start.responds(to: action) { return start }
        if let d = start.delegate as? NSObject, d.responds(to: action) { return d }
        return nil
    }
}

// MARK: - Synthetic key events (automation `key`)

enum KeyEvents {
    static let codes: [Character: UInt16] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
        "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
        "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
        "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
    ]
    static let shifted: [Character: Character] = [
        "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
        "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?", "`": "~",
    ]
    static let named: [String: (UInt16, String, Bool)] = [   // code, characters, is a function key
        "enter": (36, "\r", false), "return": (36, "\r", false), "tab": (48, "\t", false), "space": (49, " ", false),
        "backspace": (51, "\u{7f}", false), "delete": (51, "\u{7f}", false), "escape": (53, "\u{1b}", false),
        "esc": (53, "\u{1b}", false), "forwarddelete": (117, "\u{f728}", true),
        "arrowleft": (123, "\u{f702}", true), "left": (123, "\u{f702}", true),
        "arrowright": (124, "\u{f703}", true), "right": (124, "\u{f703}", true),
        "arrowdown": (125, "\u{f701}", true), "down": (125, "\u{f701}", true),
        "arrowup": (126, "\u{f700}", true), "up": (126, "\u{f700}", true),
        "home": (115, "\u{f729}", true), "end": (119, "\u{f72b}", true),
        "pageup": (116, "\u{f72c}", true), "pagedown": (121, "\u{f72d}", true),
        "f1": (122, "\u{f704}", true), "f2": (120, "\u{f705}", true), "f3": (99, "\u{f706}", true),
        "f4": (118, "\u{f707}", true), "f5": (96, "\u{f708}", true), "f6": (97, "\u{f709}", true),
        "f7": (98, "\u{f70a}", true), "f8": (100, "\u{f70b}", true), "f9": (101, "\u{f70c}", true),
        "f10": (109, "\u{f70d}", true), "f11": (103, "\u{f70e}", true), "f12": (111, "\u{f70f}", true),
    ]

    static func make(key: String, mods: [String], window: NSWindow, chars charsOverride: String? = nil,
                     ignoring ignoringOverride: String? = nil) -> (NSEvent, NSEvent)? {
        var flags: NSEvent.ModifierFlags = []
        for m in mods {
            switch m.lowercased() {
            case "cmd", "command", "meta": flags.insert(.command)
            case "shift": flags.insert(.shift)
            case "alt", "option", "opt": flags.insert(.option)
            case "ctrl", "control": flags.insert(.control)
            default: break
            }
        }
        var code: UInt16
        var chars: String
        var ignoring: String
        if key.count == 1, let first = key.first {
            if first.isUppercase { flags.insert(.shift) }
            let ch = Character(first.lowercased())
            guard let c = codes[ch] else { return nil }
            code = c
            var base = String(ch)
            if flags.contains(.shift) { base = shifted[ch].map { String($0) } ?? base.uppercased() }
            ignoring = base
            chars = base
            if flags.contains(.control), let a = ch.asciiValue, ch.isLetter { chars = String(UnicodeScalar(a - 96)) }
        } else {
            guard let n = named[key.lowercased()] else { return nil }
            code = n.0
            chars = n.1
            ignoring = n.1
            if n.2 { flags.formUnion([.function]) }
            if (123...126).contains(code) { flags.insert(.numericPad) }
        }
        if let c = charsOverride { chars = c }
        if let c = ignoringOverride { ignoring = c }
        let ts = ProcessInfo.processInfo.systemUptime
        guard let down = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ts,
                                          windowNumber: window.windowNumber, context: nil, characters: chars,
                                          charactersIgnoringModifiers: ignoring, isARepeat: false, keyCode: code),
              let up = NSEvent.keyEvent(with: .keyUp, location: .zero, modifierFlags: flags, timestamp: ts + 0.01,
                                        windowNumber: window.windowNumber, context: nil, characters: chars,
                                        charactersIgnoringModifiers: ignoring, isARepeat: false, keyCode: code)
        else { return nil }
        return (down, up)
    }
}

// MARK: - App controller

@MainActor
final class AppController: NSObject, NSApplicationDelegate, NSMenuDelegate, NSMenuItemValidation {
    static var shared: AppController?

    let options: LaunchOptions
    let configDir: String
    private(set) var windows: [TexcWindow] = []
    private var automation: Automation?
    var isAutomation: Bool { options.automationDir != nil }
    var pendingPick: [String]?
    var pendingSave: String?
    var events: [[String: Any]] = []
    var onQuitDecision: ((Bool) -> Void)?
    private var openedAtLaunch = false
    private var quitInProgress = false
    private var spawnCount = 0
    private let recentMenu = NSMenu(title: "Open Recent")
    private var signalSources: [DispatchSourceSignal] = []

    init(options: LaunchOptions) {
        self.options = options
        let env = ProcessInfo.processInfo.environment
        configDir = options.configDir ?? env["TEXC_CONFIG_DIR"].flatMap { $0.isEmpty ? nil : expandPath($0) }
            ?? (NSHomeDirectory() + "/.config/texc")
        super.init()
    }

    // MARK: Child process command and environment

    struct ServerSpec { let executable: String; let arguments: [String] }

    func serverCommand(target: String?) -> ServerSpec {
        var args = ["gui"]
        if let t = target { args.append(t) }
        args.append("--app")
        if let cmd = options.serverCmd {
            return ServerSpec(executable: "/bin/sh", arguments: ["-c", "exec \(cmd) \"$@\"", "texc-server"] + args)
        }
        return ServerSpec(executable: python, arguments: [Config.home + "/texc.py"] + args)
    }

    lazy var childEnvironment: [String: String] = {
        var env = ProcessInfo.processInfo.environment
        var dirs: [String] = []
        func add<S: StringProtocol>(_ s: S) {
            let d = String(s).trimmingCharacters(in: .whitespaces)
            if !d.isEmpty && !dirs.contains(d) { dirs.append(d) }
        }
        Config.buildPath.split(separator: ":").forEach { add($0) }
        let home = NSHomeDirectory()
        ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/Library/TeX/texbin",
         "/usr/bin", "/bin", "/usr/sbin", "/sbin"].forEach { add($0) }
        (env["PATH"] ?? "").split(separator: ":").forEach { add($0) }
        env["PATH"] = dirs.joined(separator: ":")
        if (env["LANG"] ?? "").isEmpty { env["LANG"] = "en_US.UTF-8" }
        env["PYTHONUNBUFFERED"] = "1"
        env["TEXC_APP"] = "1"
        if options.automationDir != nil { env["TEXC_SILENT"] = "1" }   // servers then never open Finder/Preview/dialogs
        if let cd = options.configDir { env["TEXC_CONFIG_DIR"] = cd }
        for k in ["TEXC_SERVER_CMD", "TEXC_AUTOMATION_DIR", "TEXC_LOBBY_URL"] { env.removeValue(forKey: k) }
        return env
    }()

    /// TexcPython; `python3` from PATH only if that doesn't run.
    lazy var python: String = {
        let configured = Config.python
        if FileManager.default.isExecutableFile(atPath: configured) { return configured }
        for d in (childEnvironment["PATH"] ?? "").split(separator: ":") {
            let p = "\(d)/python3"
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        return configured
    }()

    func newLogURL(windowID: Int) -> URL {
        spawnCount += 1
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss"
        return Config.logDir.appendingPathComponent("server-\(f.string(from: Date()))-\(getpid())-w\(windowID)-\(spawnCount).log")
    }

    private func pruneLogs() {
        let dir = Config.logDir
        guard let items = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let cutoff = Date().addingTimeInterval(-7 * 24 * 3600)
        for u in items where u.lastPathComponent.hasPrefix("server-") && u.pathExtension == "log" {
            if let m = (try? u.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate, m < cutoff {
                try? FileManager.default.removeItem(at: u)
            }
        }
    }

    // MARK: Windows

    func controller(for w: NSWindow?) -> TexcWindow? {
        guard let w = w else { return nil }
        return windows.first { $0.window === w || $0.window === w.sheetParent }
    }

    /// The window menu commands act on: the key window, else (app in the background) our front-most one.
    func frontWindow() -> TexcWindow? {
        if let c = controller(for: NSApp.keyWindow) { return c }
        if let c = controller(for: NSApp.mainWindow) { return c }
        for w in NSApp.orderedWindows where !w.isMiniaturized {
            if let c = controller(for: w) { return c }
        }
        return windows.last
    }

    @discardableResult
    func makeWindow() -> TexcWindow {
        let w = TexcWindow(app: self, automation: isAutomation)
        place(w)
        windows.append(w)
        w.window.makeKeyAndOrderFront(nil)
        return w
    }

    private func place(_ w: TexcWindow) {
        if !isAutomation && !windows.contains(where: { $0.usesAutosave }) {
            if w.window.setFrameAutosaveName("texc.window") {
                w.usesAutosave = true
                return
            }
        }
        if let front = frontWindow()?.window {
            var tl = NSPoint(x: front.frame.minX + 28, y: front.frame.maxY - 28)
            if let vis = front.screen?.visibleFrame ?? NSScreen.main?.visibleFrame {
                if tl.x + w.window.frame.width > vis.maxX { tl.x = vis.minX + 20 }
                if tl.y - w.window.frame.height < vis.minY { tl.y = vis.maxY - 10 }
            }
            w.window.setFrameTopLeftPoint(tl)
        } else {
            w.window.center()
        }
    }

    func focus(_ w: TexcWindow) {
        if w.window.isMiniaturized { w.window.deminiaturize(nil) }
        w.window.makeKeyAndOrderFront(nil)   // never NSApp.activate
    }

    @discardableResult
    func newLobbyWindow(query: String? = nil) -> TexcWindow {
        let w = makeWindow()
        w.start(target: nil, query: query)
        return w
    }

    func windowDidClose(_ w: TexcWindow) {
        windows.removeAll { $0 === w }
    }

    /// Open Folder from anywhere (menu, bridge, Finder/Dock, --folder, automation).
    func openFolder(_ raw: String, newWindow: Bool, from source: TexcWindow?, completion: ((OpenOutcome) -> Void)? = nil) {
        let path = expandPath(raw)
        guard let real = realPath(path) else {
            completion?(.failed("“\(abbreviateHome(path))” isn't available. Check that it exists and that its drive is connected."))
            return
        }
        var isDir: ObjCBool = false
        FileManager.default.fileExists(atPath: real, isDirectory: &isDir)
        if !isDir.boolValue && (real as NSString).pathExtension.lowercased() != "tex" {
            completion?(.failed("texc opens folders and .tex files."))
            return
        }
        let folder = isDir.boolValue ? real : (real as NSString).deletingLastPathComponent
        if let w = windows.first(where: { !$0.isClosed && $0.mode == "project" && $0.folder == folder }) {
            focus(w)
            completion?(.focused(w))
            return
        }
        guard !newWindow, let target = source ?? frontWindow(), !target.isClosed else {
            let w = makeWindow()
            w.start(target: real)
            completion?(.opened(w))
            return
        }
        if target.mode != "project" {
            target.start(target: real)
            focus(target)
            completion?(.opened(target))
            return
        }
        target.askBeforeClose { [weak self, weak target] ok in
            guard let self = self, let target = target, !target.isClosed, ok else { completion?(.cancelled); return }
            if let w = self.windows.first(where: { $0 !== target && !$0.isClosed && $0.mode == "project" && $0.folder == folder }) {
                self.focus(w)
                completion?(.focused(w))
                return
            }
            target.start(target: real)
            completion?(.opened(target))
        }
    }

    func reportFailure(_ outcome: OpenOutcome) {
        guard case .failed(let msg) = outcome else { return }
        if isAutomation { record(["type": "alert", "message": msg]); return }
        let alert = NSAlert()
        alert.messageText = "Couldn't open the folder"
        alert.informativeText = msg
        if let w = frontWindow()?.window, w.attachedSheet == nil { alert.beginSheetModal(for: w) { _ in } } else { alert.runModal() }
    }

    // MARK: Panels (the automation `pick` / `save` overrides apply to every panel)

    func runOpenPanel(for window: NSWindow?, configure: (NSOpenPanel) -> Void, completion: @escaping ([URL]?) -> Void) {
        if let paths = pendingPick {
            pendingPick = nil
            completion(paths.map { URL(fileURLWithPath: expandPath($0)) })
            return
        }
        if isAutomation { record(["type": "panel", "kind": "open"]); completion(nil); return }   // never show one
        let panel = NSOpenPanel()
        configure(panel)
        if let w = window, w.isVisible {
            panel.beginSheetModal(for: w) { r in completion(r == .OK ? panel.urls : nil) }
        } else {
            panel.begin { r in completion(r == .OK ? panel.urls : nil) }
        }
    }

    func runSavePanel(for window: NSWindow?, suggestedName: String, completion: @escaping (URL?) -> Void) {
        if let p = pendingSave {
            pendingSave = nil
            let u = URL(fileURLWithPath: expandPath(p))
            try? FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
            completion(u)
            return
        }
        if isAutomation { record(["type": "panel", "kind": "save"]); completion(nil); return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedName
        panel.canCreateDirectories = true
        if let w = window, w.isVisible {
            panel.beginSheetModal(for: w) { r in completion(r == .OK ? panel.url : nil) }
        } else {
            panel.begin { r in completion(r == .OK ? panel.url : nil) }
        }
    }

    func pickFolder(prompt: String?, for w: TexcWindow?, completion: @escaping (String?) -> Void) {
        runOpenPanel(for: w?.window, configure: { p in
            p.canChooseDirectories = true
            p.canChooseFiles = false
            p.allowsMultipleSelection = false
            p.canCreateDirectories = true
            p.prompt = "Open"
            if let m = prompt, !m.isEmpty { p.message = m }
        }, completion: { urls in completion(urls?.first?.path) })
    }

    // MARK: Leaving the app (suppressed in automation so tests never open the user's browser or Finder)

    func record(_ e: [String: Any]) {
        guard isAutomation else { return }
        events.append(e)
        if events.count > 200 { events.removeFirst(events.count - 200) }
    }

    func openExternal(_ url: URL) {
        record(["kind": "openExternal", "url": url.absoluteString])
        if !isAutomation { NSWorkspace.shared.open(url) }
    }

    func reveal(_ path: String) {
        record(["kind": "reveal", "path": path])
        if !isAutomation { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
    }

    func openFile(_ url: URL) {
        record(["kind": "openFile", "path": url.path])
        if !isAutomation { NSWorkspace.shared.open(url) }
    }

    // MARK: Recent folders (the server's recent.json)

    var recentURL: URL { URL(fileURLWithPath: configDir).appendingPathComponent("recent.json") }

    func readRecent() -> [String] {
        guard let data = try? Data(contentsOf: recentURL),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let arr = obj["recent"] as? [[String: Any]] else { return [] }
        return arr.compactMap { d in
            guard let p = d["path"] as? String, !p.isEmpty else { return nil }
            return p
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === recentMenu else { return }
        menu.removeAllItems()
        let paths = readRecent()
        var counts: [String: Int] = [:]
        for p in paths { counts[(p as NSString).lastPathComponent, default: 0] += 1 }
        let folderIcon = NSImage(named: NSImage.folderName)
        folderIcon?.size = NSSize(width: 16, height: 16)
        for p in paths.prefix(20) {
            let name = (p as NSString).lastPathComponent
            let exists = FileManager.default.fileExists(atPath: p)
            var title = name
            if (counts[name] ?? 0) > 1 { title += " — " + abbreviateHome((p as NSString).deletingLastPathComponent) }
            let it = NSMenuItem(title: title, action: #selector(openRecent(_:)), keyEquivalent: "")
            it.target = self
            it.representedObject = p
            it.toolTip = abbreviateHome(p) + (exists ? "" : " (not available)")
            it.isEnabled = exists
            it.image = folderIcon
            menu.addItem(it)
        }
        if paths.isEmpty {
            let none = NSMenuItem(title: "No Recent Folders", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        }
        menu.addItem(.separator())
        let clear = NSMenuItem(title: "Clear Recent", action: #selector(clearRecent(_:)), keyEquivalent: "")
        clear.target = self
        clear.isEnabled = !paths.isEmpty
        menu.addItem(clear)
    }

    @objc func openRecent(_ sender: NSMenuItem) {
        guard let p = sender.representedObject as? String else { return }
        openFolder(p, newWindow: false, from: frontWindow()) { [weak self] in self?.reportFailure($0) }
    }

    @objc func clearRecent(_ sender: Any?) {
        try? FileManager.default.createDirectory(atPath: configDir, withIntermediateDirectories: true)
        try? writeJSONAtomically(["version": 1, "recent": [Any]()], to: recentURL)
    }

    // MARK: Menus

    private func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command],
                      target: AnyObject? = nil) -> NSMenuItem {
        // Shifted letters follow Apple's nib convention: an uppercase key equivalent implies Shift.
        var key = key
        var mods = mods
        if mods.contains(.shift), key.count == 1, let c = key.first, c.isLetter, c.isLowercase {
            key = key.uppercased()
            mods.remove(.shift)
        }
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.keyEquivalentModifierMask = mods
        i.target = target
        return i
    }

    private func buildMenus() {
        let main = NSMenu()
        func top(_ menu: NSMenu) {
            let holder = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
            holder.submenu = menu
            main.addItem(holder)
        }

        let appMenu = NSMenu(title: "texc")
        appMenu.addItem(item("About texc", #selector(showAbout(_:)), target: self))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Settings…", #selector(showSettings(_:)), ",", target: self))
        appMenu.addItem(.separator())
        let services = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        let servicesMenu = NSMenu(title: "Services")
        services.submenu = servicesMenu
        NSApp.servicesMenu = servicesMenu
        appMenu.addItem(services)
        appMenu.addItem(.separator())
        appMenu.addItem(item("Hide texc", #selector(NSApplication.hide(_:)), "h"))
        appMenu.addItem(item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
        appMenu.addItem(item("Show All", #selector(NSApplication.unhideAllApplications(_:))))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Quit texc", #selector(NSApplication.terminate(_:)), "q"))
        top(appMenu)

        let file = NSMenu(title: "File")
        file.addItem(item("New Project…", #selector(newProject(_:)), "n", target: self))
        file.addItem(item("New Window", #selector(newWindowAction(_:)), "n", [.command, .shift], target: self))
        file.addItem(.separator())
        file.addItem(item("Open Folder…", #selector(openFolderAction(_:)), "o", target: self))
        let recentHolder = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
        recentMenu.delegate = self
        recentMenu.autoenablesItems = false
        recentHolder.submenu = recentMenu
        file.addItem(recentHolder)
        file.addItem(.separator())
        file.addItem(item("Close Tab", #selector(closeTab(_:)), "w", target: self))
        file.addItem(item("Close Window", #selector(closeWindowAction(_:)), "w", [.command, .shift], target: self))
        file.addItem(item("Close Folder", #selector(closeFolderAction(_:)), target: self))
        file.addItem(.separator())
        file.addItem(item("Reveal in Finder", #selector(revealAction(_:)), "r", [.command, .option], target: self))
        top(file)

        // Standard selectors, target nil. Without these ⌘C/⌘V/⌘Z/⌘A do nothing in the web view.
        // Undo/Redo ask the page first and fall back to the native undo:/redo: (see editHistory).
        let edit = NSMenu(title: "Edit")
        edit.addItem(item("Undo", #selector(undoAction(_:)), "z", target: self))
        edit.addItem(item("Redo", #selector(redoAction(_:)), "z", [.command, .shift], target: self))
        edit.addItem(.separator())
        edit.addItem(item("Cut", #selector(NSText.cut(_:)), "x"))
        edit.addItem(item("Copy", #selector(NSText.copy(_:)), "c"))
        edit.addItem(item("Paste", #selector(NSText.paste(_:)), "v"))
        edit.addItem(item("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]))
        edit.addItem(item("Delete", #selector(NSText.delete(_:))))
        edit.addItem(item("Select All", #selector(NSText.selectAll(_:)), "a"))
        top(edit)

        let view = NSMenu(title: "View")
        view.addItem(item("Reload Page", #selector(reloadPage(_:)), "r", [.command, .shift], target: self))
        view.addItem(.separator())
        view.addItem(item("Actual Size", #selector(actualSize(_:)), "0", target: self))
        view.addItem(item("Zoom In", #selector(zoomIn(_:)), "+", target: self))
        let zoomInAlt = item("Zoom In", #selector(zoomIn(_:)), "=", target: self)
        zoomInAlt.isHidden = true
        zoomInAlt.allowsKeyEquivalentWhenHidden = true
        view.addItem(zoomInAlt)
        view.addItem(item("Zoom Out", #selector(zoomOut(_:)), "-", target: self))
        view.addItem(.separator())
        view.addItem(item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]))
        top(view)

        let win = NSMenu(title: "Window")
        win.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"))
        win.addItem(item("Zoom", #selector(NSWindow.performZoom(_:))))
        win.addItem(.separator())
        win.addItem(item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))))
        top(win)
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }

    func findMenuItem(_ path: [String]) -> (NSMenu, Int)? {
        func norm(_ s: String) -> String {
            var t = s.trimmingCharacters(in: .whitespaces).lowercased()
            while t.hasSuffix("…") || t.hasSuffix(".") { t.removeLast() }
            return t
        }
        guard var menu = NSApp.mainMenu else { return nil }
        for (i, name) in path.enumerated() {
            if let d = menu.delegate { d.menuNeedsUpdate?(menu) }
            let items = menu.items, want = norm(name)
            var found = items.firstIndex(where: { norm($0.title) == want && !$0.isSeparatorItem })
            if found == nil {
                // AppKit retitles some items ("Undo" → "Undo Typing"): accept a unique "<name> …" match.
                let hits = items.indices.filter { !items[$0].isSeparatorItem && !items[$0].isHidden && norm(items[$0].title).hasPrefix(want + " ") }
                if hits.count == 1 { found = hits[0] }
            }
            guard let idx = found else { return nil }
            if i == path.count - 1 { return (menu, idx) }
            guard let sub = menu.items[idx].submenu else { return nil }
            menu = sub
        }
        return nil
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        let w = frontWindow()
        switch menuItem.action {
        case #selector(closeFolderAction(_:)), #selector(revealAction(_:)):
            return w?.mode == "project" && w?.folder != nil
        case #selector(closeTab(_:)), #selector(closeWindowAction(_:)):
            return NSApp.keyWindow != nil || w != nil
        case #selector(showSettings(_:)):
            return w?.mode == "project" && w?.state == .ready
        case #selector(reloadPage(_:)), #selector(actualSize(_:)), #selector(zoomIn(_:)), #selector(zoomOut(_:)):
            return w != nil
        case #selector(undoAction(_:)), #selector(redoAction(_:)):
            if foreignKeyWindow() == nil, w != nil { return true }   // the page decides (editHistory)
            let native = Selector((menuItem.action == #selector(undoAction(_:)) ? "undo:" : "redo:"))
            return NSApp.target(forAction: native, to: nil, from: menuItem) != nil
        default:
            return true
        }
    }

    // Edit > Undo / Redo. The editor (CodeMirror) keeps its own history, which WebKit's native undo
    // of its hidden textarea knows nothing about: a native undo is recorded as a new edit and Redo
    // then has nothing to redo. So a texc page gets the first say (`undo`/`redo` → cm.undo()/cm.redo()
    // while the editor has focus); a page that doesn't handle it (null), or any other window, gets the
    // native undo:/redo: (text fields, the Welcome page, sheets). ⌘Z/⇧⌘Z typed in the editor never get
    // here: CodeMirror handles the key itself.
    @objc func undoAction(_ sender: Any?) { editHistory("undo", sender) }
    @objc func redoAction(_ sender: Any?) { editHistory("redo", sender) }

    private func editHistory(_ cmd: String, _ sender: Any?) {
        let native = Selector((cmd + ":"))
        guard foreignKeyWindow() == nil, let w = frontWindow() else {
            NSApp.sendAction(native, to: nil, from: sender)
            return
        }
        w.callPage(cmd, timeout: 3) { [weak w] r in
            guard let w = w, !w.isClosed else { return }
            if r == nil || (r as? Bool) == false { NSApp.sendAction(native, to: nil, from: sender) }
        }
    }

    @objc func showAbout(_ sender: Any?) {
        if isAutomation { record(["type": "about"]); return }
        let credits = NSAttributedString(string: "LaTeX on your Mac. Your files stay where they are.",
                                         attributes: [.foregroundColor: NSColor.secondaryLabelColor, .font: NSFont.systemFont(ofSize: 11)])
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "texc", .credits: credits])
    }

    @objc func showSettings(_ sender: Any?) {
        frontWindow()?.callPage("settings", timeout: 3) { _ in }
    }

    @objc func newProject(_ sender: Any?) {
        if let w = frontWindow(), w.mode == "lobby", w.state == .ready {
            w.callPage("newProject", timeout: 3) { [weak w] r in
                if r == nil, let w = w, !w.isClosed { w.reloadLobbyWithNewProject() }
            }
        } else {
            newLobbyWindow(query: "new=1")
        }
    }

    @objc func newWindowAction(_ sender: Any?) { newLobbyWindow() }

    @objc func openFolderAction(_ sender: Any?) {
        let w = frontWindow()
        pickFolder(prompt: "Open a LaTeX folder", for: w) { [weak self] path in
            guard let self = self, let path = path else { return }
            self.openFolder(path, newWindow: false, from: w) { self.reportFailure($0) }
        }
    }

    /// Key windows that aren't ours (About panel, sheets' owners aside) just close.
    private func foreignKeyWindow() -> NSWindow? {
        guard let k = NSApp.keyWindow else { return nil }
        if k.sheetParent != nil { return k }          // a sheet over one of our windows
        return controller(for: k) == nil ? k : nil
    }

    @objc func closeTab(_ sender: Any?) {
        if let k = foreignKeyWindow() { if k.sheetParent == nil { k.performClose(sender) }; return }
        guard let w = frontWindow() else { return }
        if w.mode == "project" && w.state == .ready {
            w.callPage("closeTab", timeout: 5, patient: true) { [weak w] r in
                guard let w = w, !w.isClosed else { return }
                if r == nil || (r as? Bool) == false { w.requestClose() }
            }
        } else {
            w.requestClose()
        }
    }

    @objc func closeWindowAction(_ sender: Any?) {
        if let k = foreignKeyWindow() { if k.sheetParent == nil { k.performClose(sender) }; return }
        frontWindow()?.requestClose()
    }

    @objc func closeFolderAction(_ sender: Any?) { frontWindow()?.closeFolder() }

    @objc func revealAction(_ sender: Any?) {
        if let f = frontWindow()?.folder { reveal(f) }
    }

    @objc func reloadPage(_ sender: Any?) { frontWindow()?.reloadPage() }
    @objc func actualSize(_ sender: Any?) { frontWindow()?.zoom(0) }
    @objc func zoomIn(_ sender: Any?) { frontWindow()?.zoom(1) }
    @objc func zoomOut(_ sender: Any?) { frontWindow()?.zoom(-1) }

    // MARK: Launch

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        NSWindow.allowsAutomaticWindowTabbing = false
        buildMenus()
        installSignalHandlers()
        pruneLogs()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let dir = options.automationDir {
            (NSApp as? TexcApplication)?.automationRouting = true
            let a = Automation(dir: dir, app: self)
            automation = a
            a.start()
        }
        for f in options.folders {
            openedAtLaunch = true
            openFolder(f, newWindow: true, from: nil) { [weak self] in self?.reportFailure($0) }
        }
        // Let a launch-time open-documents event land first, so `open -a texc FOLDER` gets no stray lobby.
        DispatchQueue.main.async { [weak self] in self?.openInitialWindows() }
    }

    private func openInitialWindows() {
        guard windows.isEmpty, !openedAtLaunch else { return }
        if !isAutomation, let saved = UserDefaults.standard.array(forKey: "TexcOpenFolders") as? [String] {
            for f in saved where FileManager.default.fileExists(atPath: f) {
                openFolder(f, newWindow: true, from: nil)
            }
            if !windows.isEmpty { return }
        }
        newLobbyWindow()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        openedAtLaunch = true
        for (i, u) in urls.enumerated() where u.isFileURL {
            openFolder(u.path, newWindow: i > 0, from: i == 0 ? frontWindow() : nil) { [weak self] in self?.reportFailure($0) }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if windows.isEmpty {
            newLobbyWindow()
            return false
        }
        return true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { [weak self] in
                guard let self = self, !self.quitInProgress else { return }
                // Not inline: .terminateLater spins a nested run loop, and the main dispatch queue isn't
                // drained inside a main-queue callout, so the quit would hang with its servers stopped.
                let t = Timer(timeInterval: 0, repeats: false) { _ in NSApp.terminate(nil) }
                RunLoop.main.add(t, forMode: .common)
            }
            src.resume()
            signalSources.append(src)
        }
    }

    // MARK: Quit

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitInProgress { return .terminateCancel }   // the pending quit replies once
        let wins = windows.filter { !$0.isClosed }
        let session = sessionFolders()
        if wins.isEmpty {
            saveSession(session)
            stopEverything()
            onQuitDecision?(true)
            onQuitDecision = nil
            return .terminateNow
        }
        quitInProgress = true
        var remaining = wins.count
        var cancelled = false
        for w in wins {
            w.askBeforeClose { [weak self] ok in
                if !ok { cancelled = true }
                remaining -= 1
                if remaining == 0 { self?.finishQuit(cancelled: cancelled, session: session) }
            }
        }
        return .terminateLater
    }

    private func finishQuit(cancelled: Bool, session: [String]) {
        if cancelled {
            quitInProgress = false
            onQuitDecision?(false)
            onQuitDecision = nil
            NSApp.reply(toApplicationShouldTerminate: false)
            return
        }
        saveSession(session)
        let procs = windows.compactMap { $0.detachServer() } + Array(ServerProcess.stopping.values)
        var remaining = procs.count
        var replied = false
        let reply = { [weak self] in
            if replied { return }
            replied = true
            self?.onQuitDecision?(true)
            self?.onQuitDecision = nil
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        if procs.isEmpty { reply(); return }
        for p in procs {
            p.stop(grace: 6) {
                remaining -= 1
                if remaining == 0 { reply() }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6.6) { reply() }
    }

    private func stopEverything() {
        for w in windows { w.detachServer()?.killNow() }
        for p in ServerProcess.stopping.values { p.killNow() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        automation?.restorePasteboard()
        stopEverything()
    }

    /// Project folders, back to front, so the front-most window is restored last (on top).
    private func sessionFolders() -> [String] {
        let ordered = NSApp.orderedWindows.compactMap { controller(for: $0) }
        let rest = windows.filter { w in !ordered.contains { $0 === w } }
        var out: [String] = []
        for w in rest + ordered.reversed() where w.mode == "project" {
            if let f = w.folder, !out.contains(f) { out.append(f) }
        }
        return out
    }

    private func saveSession(_ folders: [String]) {
        if isAutomation { return }
        UserDefaults.standard.set(folders, forKey: "TexcOpenFolders")
    }
}

// MARK: - Automation

@MainActor
final class Automation: NSObject {
    let dir: URL
    private weak var app: AppController?
    private var timer: Timer?
    private var busy = false
    private var retries: [String: Int] = [:]

    init(dir: String, app: AppController) {
        self.dir = URL(fileURLWithPath: dir, isDirectory: true)
        self.app = app
    }

    func start() {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let t = Timer(timeInterval: 0.1, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
        RunLoop.main.add(t, forMode: .common)   // keeps polling while a sheet or menu is open
        timer = t
    }

    @objc private func tick() {
        guard !busy, let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
        guard let name = names.filter({ $0.hasSuffix(".cmd.json") && !$0.hasPrefix(".") }).sorted().first else { return }
        let cmdURL = dir.appendingPathComponent(name)
        let resURL = dir.appendingPathComponent(String(name.dropLast(".cmd.json".count)) + ".res.json")
        guard let data = try? Data(contentsOf: cmdURL) else { return }
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            let n = (retries[name] ?? 0) + 1   // maybe still being written
            retries[name] = n
            if n < 10 { return }
            retries[name] = nil
            try? FileManager.default.removeItem(at: cmdURL)
            write(["ok": false, "error": "The command file isn't a JSON object."], to: resURL)
            return
        }
        retries[name] = nil
        try? FileManager.default.removeItem(at: cmdURL)
        // close/quit/open can wait on a page's beforeClose confirm for as long as the user takes; they
        // don't hold the queue, so a tester can still eval (and answer the confirm) meanwhile.
        let holdsQueue = !Automation.detached.contains((obj["cmd"] as? String) ?? "")
        busy = holdsQueue
        run(obj) { [weak self] result in
            self?.write(result, to: resURL)
            if holdsQueue { self?.busy = false }
        }
    }

    static let detached: Set<String> = ["close", "quit", "open"]

    /// Runs `fn` from a one-shot run-loop timer. Not GCD: an action that enters a nested run loop
    /// (Quit waiting for a page's confirm) must not sit inside a main-queue block, or the main queue
    /// stops draining; and not inline in tick(), or it blocks the automation timer itself.
    private var laterQueue: [() -> Void] = []
    private func later(_ fn: @escaping () -> Void) {
        laterQueue.append(fn)
        let t = Timer(timeInterval: 0, target: self, selector: #selector(runLater), userInfo: nil, repeats: false)
        RunLoop.main.add(t, forMode: .common)
    }
    @objc private func runLater() {
        guard !laterQueue.isEmpty else { return }
        laterQueue.removeFirst()()
    }

    private func write(_ result: [String: Any], to url: URL) {
        do { try writeJSONAtomically(jsonSafe(result), to: url) } catch { NSLog("texc automation: can't write %@: %@", url.path, "\(error)") }
    }

    /// The user's clipboard as it was before the first `pasteboard set` (nil: untouched).
    private var savedPasteboard: [[(NSPasteboard.PasteboardType, Data)]]?

    func restorePasteboard() {
        guard let saved = savedPasteboard else { return }
        savedPasteboard = nil
        let pb = NSPasteboard.general
        pb.clearContents()
        let items: [NSPasteboardItem] = saved.compactMap { pairs in
            if pairs.isEmpty { return nil }
            let it = NSPasteboardItem()
            for (t, d) in pairs { it.setData(d, forType: t) }
            return it
        }
        if !items.isEmpty { pb.writeObjects(items) }
    }

    private func run(_ c: [String: Any], done: @escaping ([String: Any]) -> Void) {
        guard let app = app else { return }
        let cmd = (c["cmd"] as? String) ?? ""
        func fail(_ msg: String) { done(["ok": false, "error": msg]) }
        func win() -> TexcWindow? {
            if let id = (c["window"] as? NSNumber)?.intValue { return app.windows.first { $0.id == id && !$0.isClosed } }
            return app.frontWindow()
        }
        func whenLoaded(_ w: TexcWindow, _ extra: [String: Any] = [:]) {
            let wid = w.id                    // not w: the waiter lives in w and in a 40 s timer
            w.whenLoaded(timeout: (c["timeout"] as? NSNumber)?.doubleValue ?? 40) { err in
                if let err = err { fail(err) } else { done(["ok": true, "window": wid].merging(extra) { a, _ in a }) }
            }
        }
        switch cmd {
        case "windows":
            let front = app.frontWindow()
            done(["ok": true, "windows": app.windows.filter { !$0.isClosed }.map { $0.describe(front: front) }])
        case "open":
            guard let p = c["path"] as? String, !p.isEmpty else { return fail("open needs a path") }
            app.openFolder(p, newWindow: (c["newWindow"] as? Bool) ?? false, from: app.frontWindow()) { outcome in
                switch outcome {
                case .opened(let w): whenLoaded(w)
                case .focused(let w): done(["ok": true, "window": w.id, "focused": true])
                case .cancelled: fail("cancelled")
                case .failed(let msg): fail(msg)
                }
            }
        case "lobby":
            whenLoaded(app.newLobbyWindow())
        case "eval":
            guard let w = win() else { return fail("no such window") }
            guard let js = c["js"] as? String else { return fail("eval needs js") }
            w.evalForAutomation(js, timeout: (c["timeout"] as? NSNumber)?.doubleValue ?? 30, done)
        case "snapshot":
            guard let w = win() else { return fail("no such window") }
            guard let p = c["path"] as? String, !p.isEmpty else { return fail("snapshot needs a path") }
            w.snapshot(to: p, done)
        case "key":
            guard let w = win() else { return fail("no such window") }
            guard let key = c["key"] as? String, !key.isEmpty else { return fail("key needs a key") }
            let mods = (c["mods"] as? [String]) ?? []
            if app.frontWindow() !== w || (NSApp.isActive && !w.window.isKeyWindow && w.window.attachedSheet == nil) {
                w.window.makeKeyAndOrderFront(nil)   // allowed; activating the app isn't
            }
            guard let (down, up) = KeyEvents.make(key: key, mods: mods, window: w.window.attachedSheet ?? w.window,
                                                  chars: c["chars"] as? String, ignoring: c["charsIgnoringModifiers"] as? String) else {
                return fail("unknown key \(key)")
            }
            NSApp.sendEvent(down)
            let routing = (NSApp as? TexcApplication)?.lastRouting ?? ""
            NSApp.sendEvent(up)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { done(["ok": true, "routing": routing]) }
        case "menu":
            guard let path = c["path"] as? [String], !path.isEmpty else { return fail("menu needs a path") }
            guard let (menu, idx) = app.findMenuItem(path) else { return fail("no menu item \(path.joined(separator: " > "))") }
            if (c["list"] as? Bool) == true {   // {"cmd":"menu","path":["File","Open Recent"],"list":true}
                guard let sub = menu.item(at: idx)?.submenu else { return fail("\(path.joined(separator: " > ")) has no submenu") }
                sub.delegate?.menuNeedsUpdate?(sub)
                sub.update()
                return done(["ok": true, "items": sub.items.map { it -> [String: Any] in
                    it.isSeparatorItem ? ["separator": true]
                        : ["title": it.title, "enabled": it.isEnabled, "key": it.keyEquivalent, "tooltip": orNull(it.toolTip)]
                }])
            }
            menu.update()
            guard let it = menu.item(at: idx), it.isEnabled else { return fail("menu item \(path.joined(separator: " > ")) is disabled") }
            later { menu.performActionForItem(at: idx) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { done(["ok": true]) }
        case "pasteboard":
            // The general pasteboard is the user's clipboard: the first `set` backs it up (every item,
            // every type) and `restore` (or quitting) puts it back, so a test never eats a copy.
            let pb = NSPasteboard.general
            if (c["restore"] as? Bool) == true {
                restorePasteboard()
                return done(["ok": true, "text": orNull(pb.string(forType: .string))])
            }
            if let s = c["set"] as? String {
                if savedPasteboard == nil {
                    savedPasteboard = (pb.pasteboardItems ?? []).map { item in
                        item.types.compactMap { t in item.data(forType: t).map { (t, $0) } }
                    }
                }
                pb.clearContents()
                pb.setString(s, forType: .string)
            }
            done(["ok": true, "text": orNull(pb.string(forType: .string))])
        case "pick":
            if let ps = c["paths"] as? [String], !ps.isEmpty { app.pendingPick = ps }
            else if let p = c["path"] as? String, !p.isEmpty { app.pendingPick = [p] }
            else { return fail("pick needs a path") }
            done(["ok": true])
        case "save":
            guard let p = c["path"] as? String, !p.isEmpty else { return fail("save needs a path") }
            app.pendingSave = p
            done(["ok": true])
        case "close":
            guard let w = win() else { return fail("no such window") }
            w.requestClose { closed in done(["ok": true, "closed": closed]) }
        case "quit":
            restorePasteboard()
            app.onQuitDecision = { ok in done(ok ? ["ok": true] : ["ok": false, "error": "A window cancelled the quit."]) }
            later { NSApp.terminate(nil) }
        case "events":
            done(["ok": true, "events": app.events])
            if (c["clear"] as? Bool) == true { app.events = [] }
        default:
            fail("unknown cmd \(cmd)")
        }
    }
}

// MARK: - Icon (drawn in code; build.sh runs `texc --render-icon DIR` then iconutil)

enum IconRenderer {
    static func render(to dir: String) -> Bool {
        let url = URL(fileURLWithPath: expandPath(dir), isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let specs: [(String, Int)] = [
            ("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
            ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
            ("icon_512x512", 512), ("icon_512x512@2x", 1024),
        ]
        for (name, px) in specs {
            guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                                             samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                             bytesPerRow: 0, bitsPerPixel: 0),
                  let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return false }
            rep.size = NSSize(width: px, height: px)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = ctx
            ctx.imageInterpolation = .high
            ctx.cgContext.scaleBy(x: CGFloat(px) / 1024, y: CGFloat(px) / 1024)
            draw(small: px <= 32)
            ctx.flushGraphics()
            NSGraphicsContext.restoreGraphicsState()
            guard let png = rep.representation(using: .png, properties: [:]) else { return false }
            do { try png.write(to: url.appendingPathComponent(name + ".png")) } catch { return false }
        }
        return true
    }

    /// A dark rounded square with a white serif "tx" (the x dropped a little, like the E in TeX)
    /// and a blue text caret. Coordinates are on the 1024-point macOS icon grid.
    static func draw(small: Bool) {
        let body = NSRect(x: 100, y: 100, width: 824, height: 824)
        let radius: CGFloat = 185
        let shape = NSBezierPath(roundedRect: body, xRadius: radius, yRadius: radius)

        if !small {
            NSGraphicsContext.saveGraphicsState()
            let shadow = NSShadow()
            shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
            shadow.shadowOffset = NSSize(width: 0, height: -12)
            shadow.shadowBlurRadius = 28
            shadow.set()
            NSColor.black.setFill()
            shape.fill()
            NSGraphicsContext.restoreGraphicsState()
        }
        let top = NSColor(srgbRed: 0.17, green: 0.17, blue: 0.19, alpha: 1)
        let bottom = NSColor(srgbRed: 0.03, green: 0.03, blue: 0.04, alpha: 1)
        NSGradient(starting: top, ending: bottom)?.draw(in: shape, angle: -90)
        let rim = NSBezierPath(roundedRect: body.insetBy(dx: 3, dy: 3), xRadius: radius - 3, yRadius: radius - 3)
        rim.lineWidth = small ? 10 : 5
        NSColor(white: 1, alpha: small ? 0.16 : 0.10).setStroke()
        rim.stroke()

        let size: CGFloat = small ? 520 : 470
        let font = serifFont(size: size)
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
        let t = NSAttributedString(string: "t", attributes: attrs)
        let x = NSAttributedString(string: "x", attributes: attrs)
        let tw = t.size().width, xw = x.size().width
        let kern: CGFloat = small ? -0.02 * size : -0.035 * size
        let drop: CGFloat = small ? 0.06 * size : 0.11 * size
        let caretGap: CGFloat = small ? 0 : 0.07 * size
        let caretW: CGFloat = small ? 0 : 0.055 * size
        let total = tw + kern + xw + caretGap + caretW
        let originX = body.midX - total / 2
        // Centre the ink vertically. Large: the caret spans [baseline - drop - 0.12·size, baseline + capHeight].
        // Small: the t's top (≈ 0.82 capHeight) to the dropped x's bottom. (xHeight is unreliable here.)
        let cap = font.capHeight
        let baseline = small ? body.midY - (0.82 * cap - drop) / 2 : body.midY - (cap - drop - 0.12 * size) / 2
        t.draw(at: NSPoint(x: originX, y: baseline + font.descender))
        x.draw(at: NSPoint(x: originX + tw + kern, y: baseline - drop + font.descender))
        if !small {
            let caretX = originX + tw + kern + xw + caretGap
            let caretRect = NSRect(x: caretX, y: baseline - drop - 0.12 * size, width: caretW, height: font.capHeight + 0.12 * size + drop)
            NSColor(srgbRed: 0.49, green: 0.72, blue: 1.0, alpha: 1).setFill()
            NSBezierPath(roundedRect: caretRect, xRadius: caretW / 2, yRadius: caretW / 2).fill()
        }
    }

    static func serifFont(size: CGFloat) -> NSFont {
        let base = NSFont.systemFont(ofSize: size, weight: .semibold)
        if let d = base.fontDescriptor.withDesign(.serif), let f = NSFont(descriptor: d, size: size) { return f }
        return NSFont(name: "Times New Roman Bold", size: size) ?? base
    }
}

// MARK: - Entry point

@main
enum TexcMain {
    @MainActor
    static func main() {
        let options = LaunchOptions.parse(CommandLine.arguments, env: ProcessInfo.processInfo.environment)
        if let dir = options.renderIconDir {
            exit(IconRenderer.render(to: dir) ? 0 : 1)
        }
        let app = TexcApplication.shared
        let controller = AppController(options: options)
        AppController.shared = controller
        app.delegate = controller
        // Automation (tests) runs as an accessory app: no Dock icon, no menu bar takeover, never frontmost.
        app.setActivationPolicy(options.automationDir != nil ? .accessory : .regular)
        app.run()
    }
}
