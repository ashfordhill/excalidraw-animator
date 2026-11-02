import { IconButton } from "../components/IconButton";
import { useApp } from "../components/App";

import { setDrawerOpen, toggleRecording, useAnimator } from "./animator";
import { recordIcon, timelineIcon } from "./Player";

export const AnimationToolbarButtons = () => {
  const app = useApp();
  const s = useAnimator();
  return (
    <>
      <IconButton
        type="toggle"
        size="small"
        className="anim-record-btn"
        icon={recordIcon}
        checked={s.recording}
        title={s.recording ? "Stop recording — G" : "Record animation — G"}
        aria-label="Record animation"
        onSelect={() => toggleRecording(app)}
      />
      <IconButton
        type="toggle"
        size="small"
        icon={timelineIcon}
        checked={s.drawerOpen}
        title="Timeline"
        aria-label="Timeline"
        onSelect={() => setDrawerOpen(!s.drawerOpen)}
      />
    </>
  );
};
