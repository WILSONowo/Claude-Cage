# xterm build with the IME composition fix

`xterm-6.0.0-ime.mjs` is `@xterm/xterm` built from the upstream fix for
dropped and duplicated IME composition commits:

- Upstream issue: https://github.com/xtermjs/xterm.js/issues/5023
- Upstream fix: https://github.com/xtermjs/xterm.js/pull/6060
- Built from: `AmethystLiang/xterm.js@35dd7ff28da7d115ff27511bb0dd42e206ee7e72`
  (branch `fix/ibus-hangul-composition-commits`, rebased on `master`)

Why it is vendored: no published `@xterm/xterm` release contains the fix yet.
On Linux with fcitx5 the unpatched 6.0.0 build emits one IME commit twice —
the committed text once, then the whole helper textarea again — so punctuation
and Chinese input appear duplicated.

How it was produced:

```sh
git clone --branch fix/ibus-hangul-composition-commits \
  https://github.com/AmethystLiang/xterm.js.git
cd xterm.js && npm ci && npm run build && npm run esbuild
cp lib/xterm.mjs <this directory>/xterm-6.0.0-ime.mjs
```

`scripts/patch-xterm-ime.mjs` copies this file over the installed
`@xterm/xterm` ESM entry during `npm ci`/`npm install`. Remove the vendor file
and the `postinstall` entry once a released xterm contains the fix.

License: MIT, same as `@xterm/xterm`.
