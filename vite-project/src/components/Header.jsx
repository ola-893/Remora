import { Link, useLocation } from "react-router-dom";
import { navigation, isCurrentPage } from "../lib/navigation";
import remoraLogo from "../../../brand/remora/assets/remora-lockup-color.svg";
export default function Header() {
  const { pathname } = useLocation();
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link to="/" aria-label="Remora home" className="app-brand">
          <img src={remoraLogo} alt="" width="125" height="39" />
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
