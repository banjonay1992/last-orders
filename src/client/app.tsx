import { isRoomCode, normaliseRoomCode } from "../shared/limits";
import { usePath } from "./router";
import { Landing } from "./views/landing";
import { HostPage } from "./views/host";
import { TeamPage } from "./views/team";
import { Ended } from "./components";

function NotFound() {
  return <Ended title="Nothing here" message="That page does not exist. Check the room code or start again." />;
}

export function App() {
  const path = usePath();
  const parts = path.split("/").filter(Boolean);
  const code = parts[1] ? normaliseRoomCode(decodeURIComponent(parts[1])) : "";
  const validCode = isRoomCode(code);

  switch (parts[0]) {
    case undefined:
      return <Landing />;
    case "editor":
      return <NotFound />;
    case "host":
      return validCode ? <HostPage key={code} code={code} /> : <NotFound />;
    case "play":
      return validCode ? <TeamPage key={code} code={code} /> : <Landing />;
    case "screen":
      return validCode ? <NotFound /> : <NotFound />;
    default:
      return <NotFound />;
  }
}
