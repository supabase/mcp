import '../../shared/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ShowRow } from './ShowRow';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <ShowRow />
  </StrictMode>
);
