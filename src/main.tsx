import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const isMonitorTarget = (event: Event) => {
  const target = event.target;
  return target instanceof Element && target.closest(".monitor-card") !== null;
};

const isDvdOcrTarget = (event: Event) => {
  const target = event.target;
  return target instanceof Element && target.closest(".dvdx-page") !== null;
};

const isEditableTarget = (event: Event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return (
    target.isContentEditable ||
    tag === "input" ||
    tag === "textarea" ||
    tag === "select"
  );
};

const blockEvent = (event: Event) => {
  const isKeyboardEvent = event.type.startsWith("key") || event.type === "selectstart";
  if (isKeyboardEvent && (isMonitorTarget(event) || isDvdOcrTarget(event) || isEditableTarget(event))) {
    return;
  }
  event.preventDefault();
};

document.addEventListener("contextmenu", blockEvent, { capture: true });
document.addEventListener("selectstart", blockEvent, { capture: true });
document.addEventListener("dragstart", blockEvent, { capture: true });
document.addEventListener("keydown", blockEvent, { capture: true });
document.addEventListener("keypress", blockEvent, { capture: true });
document.addEventListener("keyup", blockEvent, { capture: true });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
