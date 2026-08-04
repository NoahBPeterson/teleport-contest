// ---- hand-written runtime prelude (tools/c2js/runtime/hacklib-prelude.js) ----
// hacklib.c needs no extern stubs beyond libc: every external call it makes
// (string/memory/printf-family/malloc/qsort/read/write/ctype) is provided by
// js/cptr.js operating on the CPtr pointer model. This prelude intentionally
// only documents that fact. Any future hacklib extern (e.g. panic, if the
// #if 0'd guard in str_start_is is ever enabled) gets stubbed here.
// ---- end runtime prelude ----
