import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Separate port from frontend/ (3000) and backend (3001/8080) so both apps can
// run side by side locally while you compare marketing site vs. the product app.
export default defineConfig({
    plugins: [react()],
    server: { port: 3002 },
});
