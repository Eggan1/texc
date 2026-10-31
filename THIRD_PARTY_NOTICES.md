# Third-party software

texc bundles these libraries in `gui/vendor/`, unmodified (minified builds). They keep their own
licenses, reproduced or referenced below.

| Library | Version | License | Upstream |
|---|---|---|---|
| CodeMirror | 5.65.18 | MIT | https://github.com/codemirror/codemirror5 |
| PDF.js | 3.11.174 | Apache-2.0 | https://github.com/mozilla/pdf.js |
| KaTeX | 0.16.11 | MIT | https://github.com/KaTeX/KaTeX |
| marked | 12.0.2 | MIT | https://github.com/markedjs/marked |
| DOMPurify | 3.1.6 | Apache-2.0 or MPL-2.0 (used under Apache-2.0) | https://github.com/cure53/DOMPurify |

The full text of the Apache License 2.0 is in [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt).

---

## CodeMirror 5

MIT License

Copyright (C) 2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## KaTeX

The MIT License (MIT)

Copyright (c) 2013-2020 Khan Academy and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## marked

Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/)
Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

marked's full license file, which also carries the license of the original Markdown, is at
https://github.com/markedjs/marked/blob/v12.0.2/LICENSE.md.

## PDF.js

Copyright 2023 Mozilla Foundation

Licensed under the Apache License, Version 2.0 (see [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt)).
The license notice is also kept at the top of `gui/vendor/pdfjs/pdf.min.js` and `pdf.worker.min.js`.

## DOMPurify

(c) Cure53 and other contributors. Released under the Apache License 2.0 and the Mozilla Public
License 2.0; texc uses it under the Apache License 2.0 (see [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt)).
The license notice is also kept at the top of `gui/vendor/dompurify/purify.min.js`.
