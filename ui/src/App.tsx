import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AgentsPage } from "./pages/Agents";
import { AnalyticsPage } from "./pages/Analytics";
import { MemoryPage } from "./pages/Memory";
import { ModelsPage } from "./pages/Models";
import { OverviewPage } from "./pages/Overview";
import { ProjectsPage } from "./pages/Projects";
import { SessionsPage } from "./pages/Sessions";
import { SettingsPage } from "./pages/Settings";
import { SkillsPage } from "./pages/Skills";
import { WorkPage } from "./pages/Work";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="work" element={<WorkPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="memory" element={<MemoryPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="skills" element={<SkillsPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
