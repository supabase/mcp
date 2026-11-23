import '../../shared/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ShowLogs } from './ShowLogs';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <ShowLogs />
  </StrictMode>
);
