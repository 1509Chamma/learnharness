/**
 * Resizable side panels (fork feature): the width maths — clamping, and the
 * drag direction for a handle on either edge of a panel.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clampWidth, draggedWidth } from "../components/resizable.tsx";

const spec = { min: 220, max: 520 };

describe("panel widths", () => {
	it("clamps to the panel's range and rounds", () => {
		assert.equal(clampWidth(100, spec), 220);
		assert.equal(clampWidth(900, spec), 520);
		assert.equal(clampWidth(300.6, spec), 301);
	});

	it("a right-edge handle grows the panel when dragged right; a left-edge one when dragged left", () => {
		assert.equal(draggedWidth(288, 40, "right", spec), 328);
		assert.equal(draggedWidth(288, -40, "right", spec), 248);
		assert.equal(draggedWidth(416, -40, "left", { min: 300, max: 760 }), 456);
		assert.equal(draggedWidth(416, 500, "left", { min: 300, max: 760 }), 300);
	});
});
