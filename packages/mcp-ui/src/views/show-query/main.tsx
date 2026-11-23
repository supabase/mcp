import '../../shared/base.css';
import './view.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ShowQuery } from './ShowQuery';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <ShowQuery />
  </StrictMode>
);
