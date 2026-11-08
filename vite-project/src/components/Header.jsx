import { Link, useLocation } from "react-router-dom";
import { navigation, isCurrentPage } from "../lib/navigation";
export default function Header() {
  const { pathname } = useLocation();
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link to="/" aria-label="agentStreams home" className="app-brand">
          <span aria-hidden="true">A</span>agentStreams
        </Link>
        <nav aria-label="Main navigation">
          {navigation.map(({ path, label }) => (
            <Link
              key={path}
              to={path}
              aria-current={isCurrentPage(path, pathname) ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="app-network">
          <span>NEAR</span>
          <span>Test environment</span>
        </div>
      </div>
    </header>
  );
}
