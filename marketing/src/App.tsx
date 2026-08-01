import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { LangProvider, useLang } from './LangContext';
import Header from './components/Header';
import Footer from './components/Footer';
import Home from './pages/Home';
import About from './pages/About';
import Contact from './pages/Contact';
import Terms from './pages/Terms';
import Privacy from './pages/Privacy';
import Help from './pages/Help';
import Faq from './pages/Faq';

function AppShell() {
  const { isRTL } = useLang();
  return (
    <div className={`mk-root ${isRTL ? 'mk-rtl' : 'mk-ltr'}`}>
      <Header />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/help" element={<Help />} />
        <Route path="/faq" element={<Faq />} />
      </Routes>
      <Footer />
    </div>
  );
}

// Every real page lives under /:lang (ar|en) — macrocore.io/ar is the Arabic homepage,
// macrocore.io/en is the English one. Bare "/" and any unrecognized /:lang value fall
// back to /ar (Arabic is the default/primary market — Kuwait).
function LangGate() {
  const { lang } = useParams<{ lang: string }>();
  if (lang !== 'ar' && lang !== 'en') return <Navigate to="/ar" replace />;
  return (
    <LangProvider>
      <AppShell />
    </LangProvider>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/:lang/*" element={<LangGate />} />
      <Route path="/" element={<Navigate to="/ar" replace />} />
      <Route path="*" element={<Navigate to="/ar" replace />} />
    </Routes>
  );
}
