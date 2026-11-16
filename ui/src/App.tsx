import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";

const OverviewPage = lazy(() =>
  import("./pages/Overview").then((module) => ({ default: module.OverviewPage })),
);
const SessionsPage = lazy(() =>
  import("./pages/Sessions").then((module) => ({ default: module.SessionsPage })),
);
const WorkPage = lazy(() =>
  import("./pages/Work").then((module) => ({ default: module.WorkPage })),
);
const AgentsPage = lazy(() =>
  import("./pages/Agents").then((module) => ({ default: module.AgentsPage })),
);
const ModelsPage = lazy(() =>
  import("./pages/Models").then((module) => ({ default: module.ModelsPage })),
);
const MemoryPage = lazy(() =>
  import("./pages/Memory").then((module) => ({ default: module.MemoryPage })),
);
const ProjectsPage = lazy(() =>
  import("./pages/Projects").then((module) => ({ default: module.ProjectsPage })),
);
const SkillsPage = lazy(() =>
  import("./pages/Skills").then((module) => ({ default: module.SkillsPage })),
);
const AnalyticsPage = lazy(() =>
  import("./pages/Analytics").then((module) => ({ default: module.AnalyticsPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/Settings").then((module) => ({ default: module.SettingsPage })),
);

function RouteFallback() {
  return (
    <div className="flex h-40 items-center justify-center text-xs text-muted" role="status">
      Cargando…
    </div>
  );
}

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Lazy><OverviewPage /></Lazy>} />
        <Route path="sessions" element={<Lazy><SessionsPage /></Lazy>} />
        <Route path="work" element={<Lazy><WorkPage /></Lazy>} />
        <Route path="agents" element={<Lazy><AgentsPage /></Lazy>} />
        <Route path="models" element={<Lazy><ModelsPage /></Lazy>} />
        <Route path="memory" element={<Lazy><MemoryPage /></Lazy>} />
        <Route path="projects" element={<Lazy><ProjectsPage /></Lazy>} />
        <Route path="skills" element={<Lazy><SkillsPage /></Lazy>} />
        <Route path="analytics" element={<Lazy><AnalyticsPage /></Lazy>} />
        <Route path="settings" element={<Lazy><SettingsPage /></Lazy>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
