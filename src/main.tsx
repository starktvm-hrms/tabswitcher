import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Presenter from './Presenter';
import Audience from './poll/Audience';
import './styles.css';

// /p/CODE (from the QR code) or /p → audience answer page; anything else → presenter.
const m = /^\/p(?:\/([A-Za-z0-9]{1,8}))?\/?$/.exec(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {m ? <Audience code={m[1]} /> : <Presenter />}
  </StrictMode>,
);
