import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../shared/styles.css';
import { ListTables } from './ListTables';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <ListTables />
  </StrictMode>
);
