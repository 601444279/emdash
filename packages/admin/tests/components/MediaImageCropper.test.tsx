import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { MediaImageCropper } from "../../src/components/MediaImageCropper.js";
import { render } from "../utils/render.tsx";

function sourceUrl(width = 4, height = 2): string {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d")!;
	context.fillStyle = "blue";
	context.fillRect(0, 0, width, height);
	return canvas.toDataURL("image/png");
}

function Harness(props: {
	disabled?: boolean;
	resizable?: boolean;
	onSourceReady?: (size: { width: number; height: number }) => void;
	onCropComplete?: (crop: { x: number; y: number; width: number; height: number }) => void;
}) {
	const [crop, setCrop] = React.useState({ x: 0, y: 0 });
	const [zoom, setZoom] = React.useState(1);
	const [cropSize, setCropSize] = React.useState<{ width: number; height: number }>();
	return (
		<>
			<MediaImageCropper
				src={props.resizable ? sourceUrl(400, 200) : sourceUrl()}
				crop={crop}
				zoom={zoom}
				aspect={props.resizable ? 2 : undefined}
				disabled={props.disabled}
				cropSize={props.resizable ? cropSize : undefined}
				resizable={props.resizable}
				onCropChange={setCrop}
				onZoomChange={setZoom}
				onCropSizeChange={setCropSize}
				onCropComplete={props.onCropComplete ?? vi.fn()}
				onSourceReady={props.onSourceReady ?? vi.fn()}
				onSourceError={vi.fn()}
			/>
			<output aria-label="Crop position">{`${crop.x},${crop.y}`}</output>
			<output aria-label="Crop size">
				{cropSize ? `${Math.round(cropSize.width)}x${Math.round(cropSize.height)}` : "pending"}
			</output>
		</>
	);
}

function readCropSize(element: HTMLElement): { width: number; height: number } {
	const [width, height] = element.textContent!.split("x").map(Number);
	return { width: width!, height: height! };
}

describe("MediaImageCropper", () => {
	it("loads the source ratio without injecting runtime styles", async () => {
		const onSourceReady = vi.fn();
		const styleCount = document.head.querySelectorAll("style").length;
		const screen = await render(<Harness onSourceReady={onSourceReady} />);

		await vi.waitFor(() => expect(onSourceReady).toHaveBeenCalledWith({ width: 4, height: 2 }));
		expect(document.head.querySelectorAll("style")).toHaveLength(styleCount);
		await expect
			.element(screen.getByText("Drag the image or use the Arrow keys to position the crop."))
			.toBeVisible();
	});

	it("supports labelled zoom and Arrow-key positioning", async () => {
		const onCropComplete = vi.fn();
		const screen = await render(<Harness onCropComplete={onCropComplete} />);
		const cropArea = screen.getByLabelText("Crop image. Use arrow keys to move the crop area.");
		await expect.element(cropArea).toBeVisible();

		const zoom = screen.getByRole("slider", { name: "Zoom" });
		zoom.element().focus();
		await userEvent.keyboard("{ArrowRight}");
		await expect.element(screen.getByText("101%")).toBeVisible();

		cropArea.element().focus();
		await userEvent.keyboard("{ArrowRight}");
		await expect.element(screen.getByLabelText("Crop position")).not.toHaveTextContent("0,0");
		await vi.waitFor(() => expect(onCropComplete).toHaveBeenCalled());
	});

	it("removes disabled crop controls from keyboard interaction", async () => {
		const screen = await render(<Harness disabled />);
		const cropArea = screen.getByLabelText("Crop image. Use arrow keys to move the crop area.");

		expect(cropArea.element().tabIndex).toBe(-1);
		await expect.element(cropArea).toHaveAttribute("aria-disabled", "true");
		await expect.element(screen.getByRole("slider", { name: "Zoom" })).toBeDisabled();
	});

	it("resizes a freeform crop edge directly with the pointer", async () => {
		const screen = await render(<Harness resizable />);
		const cropSize = screen.getByLabelText("Crop size");
		await expect.element(cropSize).not.toHaveTextContent("pending");
		const initial = readCropSize(cropSize.element());
		const rightHandle = screen.getByRole("button", { name: "Resize crop from right edge" });
		const handle = rightHandle.element();
		vi.spyOn(handle, "setPointerCapture").mockImplementation(() => {});
		vi.spyOn(handle, "hasPointerCapture").mockReturnValue(true);
		vi.spyOn(handle, "releasePointerCapture").mockImplementation(() => {});

		handle.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				button: 0,
				isPrimary: true,
				pointerId: 7,
				clientX: 100,
			}),
		);
		handle.dispatchEvent(
			new PointerEvent("pointermove", {
				bubbles: true,
				pointerId: 7,
				clientX: 90,
			}),
		);
		handle.dispatchEvent(
			new PointerEvent("pointerup", {
				bubbles: true,
				pointerId: 7,
				clientX: 90,
			}),
		);

		await expect.element(cropSize).toHaveTextContent(`${initial.width - 20}x${initial.height}`);
		await expect
			.element(screen.getByText(`Crop area ${initial.width - 20} by ${initial.height} pixels.`))
			.toBeInTheDocument();
	});

	it("resizes every freeform edge from the keyboard", async () => {
		const screen = await render(<Harness resizable />);
		const cropSize = screen.getByLabelText("Crop size");
		await expect.element(cropSize).not.toHaveTextContent("pending");
		const initial = readCropSize(cropSize.element());

		const rightHandle = screen.getByRole("button", { name: "Resize crop from right edge" });
		rightHandle.element().focus();
		await userEvent.keyboard("{ArrowLeft}");
		await expect.element(cropSize).toHaveTextContent(`${initial.width - 2}x${initial.height}`);

		const topHandle = screen.getByRole("button", { name: "Resize crop from top edge" });
		topHandle.element().focus();
		await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
		await expect.element(cropSize).toHaveTextContent(`${initial.width - 2}x${initial.height - 20}`);

		const bottomHandle = screen.getByRole("button", { name: "Resize crop from bottom edge" });
		bottomHandle.element().focus();
		await userEvent.keyboard("{ArrowUp}");
		await expect.element(cropSize).toHaveTextContent(`${initial.width - 2}x${initial.height - 22}`);

		const leftHandle = screen.getByRole("button", { name: "Resize crop from left edge" });
		leftHandle.element().focus();
		await userEvent.keyboard("{ArrowRight}");
		await expect.element(cropSize).toHaveTextContent(`${initial.width - 4}x${initial.height - 22}`);
	});

	it("keeps a freeform crop inside the frame when the frame shrinks", async () => {
		const screen = await render(<Harness resizable />);
		const cropSize = screen.getByLabelText("Crop size");
		await expect.element(cropSize).not.toHaveTextContent("pending");
		const frame = document.querySelector<HTMLElement>(".emdash-image-cropper")!;
		frame.style.width = "100px";
		frame.style.height = "100px";
		window.dispatchEvent(new Event("resize"));

		await vi.waitFor(() => {
			const resized = readCropSize(cropSize.element());
			expect(resized.width).toBeLessThanOrEqual(100);
			expect(resized.height).toBeLessThanOrEqual(100);
		});
	});
});
