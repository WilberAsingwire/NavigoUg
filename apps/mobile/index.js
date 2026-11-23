import { registerRootComponent } from "expo";
import App from "./App";
import AppErrorBoundary from "./AppErrorBoundary";

function Root() {
  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  );
}

registerRootComponent(Root);
