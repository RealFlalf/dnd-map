import { Link, Route, Routes } from 'react-router';
import { HomePage } from './pages/HomePage';
import { SessionPage } from './pages/SessionPage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/s/:inviteCode" element={<SessionPage />} />
      <Route
        path="*"
        element={
          <main className="page narrow centered">
            <p>Страница не найдена.</p>
            <Link to="/">На главную</Link>
          </main>
        }
      />
    </Routes>
  );
}
