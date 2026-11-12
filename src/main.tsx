import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Presenter from './Presenter';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Presenter />
  </StrictMode>,
);
