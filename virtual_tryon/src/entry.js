// Keep camera, WebGL and inference clients out of the introduction page.
if (location.pathname.replace(/\/$/, "") === "/studio") {
  import("./main.js");
} else {
  import("./home.js");
}
