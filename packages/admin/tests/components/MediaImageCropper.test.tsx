import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { MediaImageCropper } from "../../src/components/MediaImageCropper.js";
import { render } from "../utils/render.tsx";

function sourceUrl(): string {
	const canvas = document.createElement("canvas");
	canvas.width = 4;
	canvas.height = 2;
	const context = canvas.getContext("2d")!;
	context.fillStyle = "blue";
	context.fillRect(0, 0, 4, 2);
	return canvas.toDataURL("image/png");
}

function Harness(props: {
	disabled?: boolean;
	onSourceReady?: (size: { width: number; height: number }) => void;
	onCropComplete?: (crop: { x: number; y: number; width: number; height: number }) => void;
}) {
	const [crop, setCrop] = React.useState({ x: 0, y: 0 });
	const [zoom, setZoom] = React.useState(1);
	return (
		<>
			<MediaImageCropper
				src={sourceUrl()}
				crop={crop}
				zoom={zoom}
				disabled={props.disabled}
				onCropChange={setCrop}
				onZoomChange={setZoom}
				onCropComplete={props.onCropComplete ?? vi.fn()}
				onSourceReady={props.onSourceReady ?? vi.fn()}
				onSourceError={vi.fn()}
			/>
			<output aria-label="Crop position">{`${crop.x},${crop.y}`}</output>
		</>
	);
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
});
