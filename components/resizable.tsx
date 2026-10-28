"use client";
/**
 * Resizable side panels (fork feature): a drag handle on a panel's inner
 * edge and the width it controls, remembered per panel on this device
 * (localStorage). Drag to resize, double-click the handle to reset, or
 * focus it and use ←/→ (Shift for bigger steps). Widths are clamped to the
 * panel's min/max.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface WidthSpec {
	/** localStorage key suffix, e.g. "sidebar". */
	key: string;
	initial: number;
	min: number;
	max: number;
}

export function clampWidth(width: number, spec: Pick<WidthSpec, "min" | "max">): number {
	return Math.round(Math.min(spec.max, Math.max(spec.min, width)));
}

/** The width after a drag: `side` is the edge the handle sits on — a handle
 *  on the panel's right edge grows it when dragged right, one on its left
 *  edge grows it when dragged left. */
export function draggedWidth(startWidth: number, deltaX: number, side: "left" | "right", spec: Pick<WidthSpec, "min" | "max">): number {
	return clampWidth(side === "right" ? startWidth + deltaX : startWidth - deltaX, spec);
}

const storageKey = (key: string) => `lh:panel-width:${key}`;
/** Two presses this close together (and in place) reset the width. */
const DOUBLE_PRESS_MS = 400;

export function useResizableWidth(spec: WidthSpec) {
	const [width, setWidthState] = useState(spec.initial);
	const [dragging, setDragging] = useState(false);
	useEffect(() => {
		try {
			const saved = Number(window.localStorage.getItem(storageKey(spec.key)));
			if (Number.isFinite(saved) && saved > 0) setWidthState(clampWidth(saved, spec));
		} catch {
			/* storage unavailable — keep the default */
		}
		// The spec is a constant per panel; reading it once is the intent.
	}, [spec.key]);
	const setWidth = useCallback(
		(next: number) => {
			const w = clampWidth(next, spec);
			setWidthState(w);
			try {
				window.localStorage.setItem(storageKey(spec.key), String(w));
			} catch {
				/* storage unavailable — the width still applies this session */
			}
		},
		[spec.key, spec.min, spec.max],
	);
	return { width, setWidth, dragging, setDragging, spec };
}

/** The drag handle: a thin hit area straddling the panel edge. */
export function ResizeHandle({
	side,
	label,
	state,
	className,
}: {
	/** Which edge of the panel the handle sits on. */
	side: "left" | "right";
	label: string;
	state: ReturnType<typeof useResizableWidth>;
	className?: string;
}) {
	const { width, setWidth, dragging, setDragging, spec } = state;
	const start = useRef<{ x: number; width: number } | null>(null);
	// Double-click is detected here, not via onDoubleClick: capturing the
	// pointer on press stops the browser from firing dblclick.
	const lastPress = useRef<{ at: number; x: number } | null>(null);
	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={width}
			aria-valuemin={spec.min}
			aria-valuemax={spec.max}
			tabIndex={0}
			data-testid={`resize-${spec.key}`}
			title="Drag to resize · double-click to reset"
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				const prev = lastPress.current;
				lastPress.current = { at: e.timeStamp, x: e.clientX };
				if (prev && e.timeStamp - prev.at < DOUBLE_PRESS_MS && Math.abs(e.clientX - prev.x) < 4) {
					lastPress.current = null;
					setWidth(spec.initial);
					return;
				}
				e.currentTarget.setPointerCapture(e.pointerId);
				start.current = { x: e.clientX, width };
				setDragging(true);
			}}
			onPointerMove={(e) => {
				if (!start.current) return;
				setWidth(draggedWidth(start.current.width, e.clientX - start.current.x, side, spec));
			}}
			onPointerUp={(e) => {
				start.current = null;
				setDragging(false);
				e.currentTarget.releasePointerCapture(e.pointerId);
			}}
			onPointerCancel={() => {
				start.current = null;
				setDragging(false);
			}}
			onDoubleClick={() => setWidth(spec.initial)}
			onKeyDown={(e) => {
				if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
				e.preventDefault();
				const step = e.shiftKey ? 64 : 16;
				const towardPanel = (e.key === "ArrowRight") === (side === "right");
				setWidth(width + (towardPanel ? step : -step));
			}}
			className={cn(
				"lh-no-drag group absolute top-0 z-30 h-full w-2 cursor-col-resize touch-none outline-none",
				side === "right" ? "right-0" : "left-0",
				className,
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-ring/60 group-focus-visible:bg-ring",
					dragging && "bg-ring",
				)}
			/>
		</div>
	);
}
