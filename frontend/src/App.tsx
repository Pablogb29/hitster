import { BrowserRouter, Routes, Route } from "react-router-dom";
import Lobby from "./pages/Lobby";
import Host from "./pages/Host";
import Join from "./pages/Join";
import { ErrorBoundary } from "./components/ErrorBoundary";

function Home() {
  return (
    <div className="min-h-screen bg-zinc-900 text-white p-8">
      <h1 className="text-3xl font-bold">HITSTER</h1>
      <div className="mt-4 space-x-4">
        <a className="underline" href="/host">Host</a>
        <a className="underline" href="/join">Join</a>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home/>}/>
        <Route path="/host" element={<Lobby/>}/>
        <Route path="/host/tabletop" element={<Host/>}/>
        <Route path="/join" element={<ErrorBoundary><Join/></ErrorBoundary>}/>
      </Routes>
    </BrowserRouter>
  );
}
