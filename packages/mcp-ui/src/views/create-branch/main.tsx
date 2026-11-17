import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AnnouncerProvider } from '../../shared/Announcer';
import '../../shared/styles.css';
import { CreateBranch } from './CreateBranch';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <AnnouncerProvider>
      <CreateBranch />
    </AnnouncerProvider>
  </StrictMode>
);
