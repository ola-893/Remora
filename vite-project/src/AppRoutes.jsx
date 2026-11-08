import { Routes, Route, Link } from 'react-router-dom';
import Layout from './components/Layout';
import NearWorkflow from './pages/NearWorkflow';
import NearDocs from './pages/NearDocs';
import { RemoraAgent, RemoraExplore, RemoraHome, RemoraLayout } from './pages/remora/Remora';

export default function AppRoutes() {
  const recordedOnly = window.__AGENTSTREAMS_RECORDED_ONLY__;
  return (
    <Routes>
      {!recordedOnly && (
        <Route element={<RemoraLayout />}>
          <Route index element={<RemoraHome />} />
          <Route path="explore" element={<RemoraExplore />} />
          <Route path="explore/:id" element={<RemoraAgent />} />
        </Route>
      )}
      <Route element={<Layout />}>
        {recordedOnly && <Route index element={<NearWorkflow />} />}
        <Route path="workflow" element={<NearWorkflow />} />
        <Route path="docs" element={<NearDocs />} />
        <Route path="docs/near" element={<NearDocs />} />
        <Route
          path="*"
          element={
            <section className="panel p-8 text-center">
              <p className="eyebrow">404 / Page not found</p>
              <h1 className="page-title mt-3">This page isn’t here.</h1>
              <p className="mt-3 text-slate-400">
                Use the navigation or return to the workflow.
              </p>
              <Link to={recordedOnly ? '/' : '/workflow'} className="btn-primary mt-6">
                Open NEAR workflow
              </Link>
            </section>
          }
        />
      </Route>
    </Routes>
  );
}
