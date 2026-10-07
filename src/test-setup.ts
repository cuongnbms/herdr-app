import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// jsdom lays nothing out and gives ranges no boxes (elements get empty ones); match that.
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
