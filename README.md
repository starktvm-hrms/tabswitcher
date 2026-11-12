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

## Use it on any computer

Your presentations live in a **workspace** on the server: the list, uploaded PDFs, images and videos, and control of your polls. Open **⇆ Use on another computer** to get the workspace link and QR code. Opening that link on any computer, like the podium PC or a colleague's laptop, shows the same presentations. Changes on one computer appear on the others within a few seconds. The badge at the top shows whether everything is saved.

The link contains the workspace's secret key, so share it only with people who should be able to change your presentations. You can also paste a link to switch workspaces, or start a new empty one. Anything saved only in the browser by an older version is uploaded automatically the first time.

Limits:
- Files can be up to 500 MB each.
- Each workspace holds up to 5 GB.
- Files you remove are deleted from the server.

## Multiple-choice polls and quizzes

1. Click **▤ Multiple-choice poll**, type the question and 2–8 options. Optionally tick **Correct** on one option to make it a quiz.
2. People scan the QR code and tap an option. They can change their vote until voting closes.
3. Bars on the screen grow live, showing each option's percentage and number of votes.
4. Controls at the bottom of the poll screen:
   - **Hide results** keeps the bars hidden while people vote.
   - **Reveal answer** turns the correct option green, and each phone shows "Correct!" or the right answer.
   - **Close voting** and **Clear** work as in the word cloud.

## Audio and video

- **Uploads:** you can upload video (MP4, WebM, MOV) and audio (MP3, WAV, M4A, AAC, OGG, FLAC) files and play them from the screen.
- **One sound at a time:** starting any video or audio pauses the others, and switching to another presentation pauses what was playing. YouTube and Vimeo are paused automatically too.
- **Linked decks with sound:** a Google Slides, Canva or other linked deck can't be paused from outside. If one has a video or audio in it, click **🔊** on its row to switch to **🔇 stop sound when switching away**. The deck is then unloaded while another presentation is on screen, and it restarts from the beginning when you come back.

## Live word-cloud polls

Built for big rooms: it was load-tested with 1,000 people sending 3,000 answers within 10 seconds from one shared network, with no errors. Phones retry automatically if the venue Wi-Fi hiccups.


Ask the room a question and watch the answers appear as a word cloud, live.

1. Click **☁ Word-cloud poll**, type the question, choose how many answers each person may send (1–5), and click **Create poll**. The poll becomes a tab in the playlist and in the fullscreen switcher bar, next to your decks.
2. The poll screen shows the question and a big **QR code**: people scan it with their phone camera, type an answer and press **Send**. No app, code or sign-up needed.
3. Answers appear in the cloud within a second. Common answers grow bigger, and spelling variants count as one word ("Inspiring", "inspiring!" and "INSPIRING").
4. Presenter controls are at the bottom of the poll screen and work in fullscreen:
   - **Hide QR** gives the cloud more room.
   - **Close voting** / **Reopen voting**.
   - **Clear** deletes all answers.
   - **Click a word** to hide it, for moderation.
   - **Show N hidden** brings hidden words back.

Poll controls are part of the workspace, so any computer with the workspace link can run the poll. Removing a poll from the list deletes it and its answers from the server. Polls are kept for 90 days.

**A deck shows a blank or "refused to connect" page?** It has to be shared publicly ("Anyone with the link" in Google Slides or Canva; File → Share → Embed in PowerPoint). Some sites don't allow being shown inside another page at all. For those, download the deck as PDF and upload it.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run server     # poll + workspace API on http://127.0.0.1:8791 (the dev server proxies /api and /files to it)
npm test           # unit + API tests
npm run build      # type-check + production build to dist/
```

```
src/
  Presenter.tsx    the page: playlist, stage, switcher bar
  present.ts       share link → embed link conversion, file checks (pure, tested)
  presentStore.ts  playlist (localStorage) + uploaded files (IndexedDB)
  useFullscreen.ts element fullscreen hook
  poll/            word-cloud poll: presenter stage, audience page (/p/CODE), QR code, cloud layout, API client
server/            Node.js server, no dependencies: polls (live updates via SSE) and workspaces (playlist + uploaded files)
src/workspace.ts   workspace client: share links, saving, uploads with progress
deploy/            one-time VPS setup script + deploy docs
.github/workflows/  deploy.yml (build + publish on push to main), setup-server.yml (one-time VPS setup)
```

## Deployment

Every push to `main` is built, tested and published to the `deploy-build` branch. The Hostinger VPS picks it up within a minute and nginx serves it at seminar.starkpeople.in. No secrets are needed. How it works and the one-time server setup are in [deploy/README.md](deploy/README.md).
