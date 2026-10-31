import { isRoomCode, normaliseRoomCode } from "../shared/limits";
import { usePath } from "./router";
import { Landing } from "./views/landing";
import { HostPage } from "./views/host";
import { TeamPage } from "./views/team";
import { ScreenPage } from "./views/screen";
import { EditorPage } from "./views/editor";
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
      return <EditorPage />;
    case "host":
      return validCode ? <HostPage key={code} code={code} /> : <NotFound />;
    case "play":
      return validCode ? <TeamPage key={code} code={code} /> : <Landing />;
    case "screen":
      return validCode ? <ScreenPage key={code} code={code} /> : <NotFound />;
    default:
      return <NotFound />;
  }
}
