// Usage: winprobe PID  -> JSON list of that process's windows (bounds, on-screen flag) and whether
// any of them intersects a display. Needs no Screen Recording permission (names aren't read).
import AppKit
import CoreGraphics
let pid = Int32(CommandLine.arguments.dropFirst().first ?? "") ?? -1
let info = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []
var displays: [CGRect] = []
var count: UInt32 = 0
CGGetActiveDisplayList(0, nil, &count)
var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
CGGetActiveDisplayList(count, &ids, &count)
for d in ids { displays.append(CGDisplayBounds(d)) }
var out: [[String: Any]] = []
for w in info where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let r = CGRect(x: b["X"] as? Double ?? 0, y: b["Y"] as? Double ?? 0, width: b["Width"] as? Double ?? 0, height: b["Height"] as? Double ?? 0)
    let visibleOnDisplay = displays.contains { $0.intersects(r) } && r.width > 1 && r.height > 1
    out.append(["number": w[kCGWindowNumber as String] ?? 0, "layer": w[kCGWindowLayer as String] ?? 0,
                "onscreen": w[kCGWindowIsOnscreen as String] ?? false, "alpha": w[kCGWindowAlpha as String] ?? 1,
                "bounds": [r.origin.x, r.origin.y, r.width, r.height], "intersectsDisplay": visibleOnDisplay])
}
let data = try! JSONSerialization.data(withJSONObject: ["pid": pid, "windows": out,
    "anyVisible": out.contains { ($0["intersectsDisplay"] as? Bool) == true && (($0["onscreen"] as? Bool) == true) }], options: [.prettyPrinted])
print(String(data: data, encoding: .utf8)!)
