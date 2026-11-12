import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../shared/styles.css';
import { ListProjects } from './ListProjects';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <ListProjects />
  </StrictMode>
);
