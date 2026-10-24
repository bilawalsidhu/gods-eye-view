- `npm start` opens the app in a desktop window. An Electron shell starts the
  usual dev server on `127.0.0.1` (port 4173, or a free one when it is taken),
  loads it in a sandboxed window and stops the server when the window closes;
  links to other sites open in the system browser. `npm run shortcut` adds a
  `gods-eye-view` command that opens it from any folder (Tromset, #1224).
