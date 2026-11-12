# Seminar Presenter

Present several decks, PDFs and videos **in one fullscreen window** and switch between them without leaving fullscreen.

**Live:** https://seminar.starkpeople.in

Browsers always leave fullscreen when you switch to another browser tab, and a web page can't stop that. So instead of using tabs, this app loads every presentation into a single fullscreen stage and switches between them with an on-screen bar.

## Using it

1. **Add presentations:**
   - **Links:** paste a link from Google Slides, Canva, PowerPoint for the web, Pitch, Figma, YouTube or Vimeo. Ordinary share/edit links are converted to embed links automatically.
   - **Files:** upload PDFs, images or videos. PowerPoint/Keynote files need exporting to PDF first.
2. Rename and reorder them. Click one to preview it.
3. Click **▶ Present fullscreen**, or ▶ on a row to start from that one.
4. To switch, move the mouse to the bottom edge of the screen, or click the **▦ 2 / 4** pill in the corner. Click a deck, or use ‹ ›. The bar hides itself after a few seconds.

While presenting:
- Each deck stays loaded, so switching back returns to the same slide.
- Arrow keys and clickers control the deck on screen.
- Videos pause when you switch away.
- **Esc** or **⤡ Exit** leaves fullscreen.

The list is saved in this browser, and uploaded files are kept in IndexedDB. Nothing is uploaded to a server.

**A deck shows a blank or "refused to connect" page?** It has to be shared publicly ("Anyone with the link" in Google Slides or Canva; File → Share → Embed in PowerPoint). Some sites don't allow being shown inside another page at all. For those, download the deck as PDF and upload it.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (link conversion, file checks)
npm run build      # type-check + production build to dist/
```

```
src/
  Presenter.tsx    the page: playlist, stage, switcher bar
  present.ts       share link → embed link conversion, file checks (pure, tested)
  presentStore.ts  playlist (localStorage) + uploaded files (IndexedDB)
  useFullscreen.ts element fullscreen hook
deploy/            one-time VPS setup script + deploy docs
.github/workflows/deploy.yml  build, test and deploy on push to main
```

## Deployment

Every push to `main` is built, tested and copied to the Hostinger VPS, where nginx serves it at seminar.starkpeople.in. One-time setup (server script and GitHub secrets) is in [deploy/README.md](deploy/README.md).
