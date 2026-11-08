import { Routes, Route, Link } from 'react-router-dom';
import Layout from './components/Layout';
import NearWorkflow from './pages/NearWorkflow';
import NearDocs from './pages/NearDocs';

export default function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<NearWorkflow />} />
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
              <Link to="/" className="btn-primary mt-6">
                Open NEAR workflow
              </Link>
            </section>
          }
        />
      </Route>
    </Routes>
  );
}
