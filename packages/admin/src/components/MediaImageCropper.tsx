import { Slider } from "@cloudflare/kumo/primitives/slider";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";
import Cropper, { type MediaSize, type Point, type Size } from "react-easy-crop";

import type { PixelCrop } from "../lib/crop-image.js";

type CropEdge = "top" | "right" | "bottom" | "left";

const MIN_CROP_SIZE = 40;

interface ResizeSession {
	pointerId: number;
	startCoordinate: number;
	startSize: Size;
	lastSize: Size;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}

function resizeFromEdge(size: Size, edge: CropEdge, edgeDelta: number, bounds: Size): Size {
	const horizontal = edge === "left" || edge === "right";
	const growthDirection = edge === "right" || edge === "bottom" ? 1 : -1;
	const dimension = horizontal ? size.width : size.height;
	const maximum = horizontal ? bounds.width : bounds.height;
	const minimum = Math.min(MIN_CROP_SIZE, Math.max(1, maximum / 4));
	const nextDimension = clamp(dimension + edgeDelta * growthDirection * 2, minimum, maximum);
	return horizontal
		? { width: nextDimension, height: size.height }
		: { width: size.width, height: nextDimension };
}

function handleStyle(edge: CropEdge, cropSize: Size): React.CSSProperties {
	if (edge === "top" || edge === "bottom") {
		return {
			left: "50%",
			top: `calc(50% ${edge === "top" ? "-" : "+"} ${cropSize.height / 2}px)`,
			transform: edge === "top" ? "translate(-50%, 0)" : "translate(-50%, -100%)",
		};
	}
	return {
		left: `calc(50% ${edge === "left" ? "-" : "+"} ${cropSize.width / 2}px)`,
		top: "50%",
		transform: edge === "left" ? "translate(0, -50%)" : "translate(-100%, -50%)",
	};
}

function handleBarStyle(edge: CropEdge): React.CSSProperties {
	if (edge === "top" || edge === "bottom") {
		return {
			left: "50%",
			[edge]: 0,
			transform: "translateX(-50%)",
		};
	}
	return {
		[edge]: 0,
		top: "50%",
		transform: "translateY(-50%)",
	};
}

interface CropResizeHandleProps {
	edge: CropEdge;
	label: string;
	cropSize: Size;
	disabled: boolean;
	getBounds: () => Size;
	onResize: (size: Size) => void;
	onResizeEnd: (size: Size) => void;
}

function CropResizeHandle({
	edge,
	label,
	cropSize,
	disabled,
	getBounds,
	onResize,
	onResizeEnd,
}: CropResizeHandleProps) {
	const sessionRef = React.useRef<ResizeSession | null>(null);
	const horizontal = edge === "left" || edge === "right";

	const finishResize = (event: React.PointerEvent<HTMLButtonElement>, releaseCapture: boolean) => {
		const session = sessionRef.current;
		if (!session || session.pointerId !== event.pointerId) return;
		sessionRef.current = null;
		onResizeEnd(session.lastSize);
		if (releaseCapture && event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};

	return (
		<button
			type="button"
			aria-label={label}
			disabled={disabled}
			className={`absolute z-20 touch-none rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand disabled:cursor-not-allowed ${horizontal ? "h-8 w-6 cursor-ew-resize" : "h-6 w-8 cursor-ns-resize"}`}
			style={handleStyle(edge, cropSize)}
			onPointerDown={(event) => {
				if (disabled || event.button !== 0 || !event.isPrimary || sessionRef.current) return;
				event.preventDefault();
				event.stopPropagation();
				event.currentTarget.setPointerCapture(event.pointerId);
				const coordinate = horizontal ? event.clientX : event.clientY;
				sessionRef.current = {
					pointerId: event.pointerId,
					startCoordinate: coordinate,
					startSize: cropSize,
					lastSize: cropSize,
				};
			}}
			onPointerMove={(event) => {
				const session = sessionRef.current;
				if (!session || session.pointerId !== event.pointerId) return;
				event.preventDefault();
				const coordinate = horizontal ? event.clientX : event.clientY;
				const nextSize = resizeFromEdge(
					session.startSize,
					edge,
					coordinate - session.startCoordinate,
					getBounds(),
				);
				session.lastSize = nextSize;
				onResize(nextSize);
			}}
			onPointerUp={(event) => finishResize(event, true)}
			onPointerCancel={(event) => finishResize(event, true)}
			onLostPointerCapture={(event) => finishResize(event, false)}
			onKeyDown={(event) => {
				const edgeMovement =
					edge === "left" || edge === "right"
						? event.key === "ArrowLeft"
							? -1
							: event.key === "ArrowRight"
								? 1
								: null
						: event.key === "ArrowUp"
							? -1
							: event.key === "ArrowDown"
								? 1
								: null;
				if (edgeMovement === null) return;
				event.preventDefault();
				const nextSize = resizeFromEdge(
					cropSize,
					edge,
					edgeMovement * (event.shiftKey ? 10 : 1),
					getBounds(),
				);
				onResize(nextSize);
				onResizeEnd(nextSize);
			}}
		>
			<span
				aria-hidden="true"
				className={`absolute ${horizontal ? "h-5 w-1" : "h-1 w-5"} rounded-full bg-kumo-base ring-1 ring-kumo-contrast`}
				style={handleBarStyle(edge)}
			/>
		</button>
	);
}

export interface MediaImageCropperProps {
	src: string;
	crop: Point;
	zoom: number;
	aspect?: number;
	cropSize?: Size;
	resizable?: boolean;
	disabled?: boolean;
	onCropChange: (crop: Point) => void;
	onZoomChange: (zoom: number) => void;
	onCropSizeChange?: (size: Size) => void;
	onCropComplete: (crop: PixelCrop) => void;
	onSourceReady: (size: { width: number; height: number }) => void;
	onSourceError: () => void;
	onImageReady?: (image: HTMLImageElement | null) => void;
}

export function MediaImageCropper({
	src,
	crop,
	zoom,
	aspect: aspectProp,
	cropSize,
	resizable = false,
	disabled = false,
	onCropChange,
	onZoomChange,
	onCropSizeChange,
	onCropComplete,
	onSourceReady,
	onSourceError,
	onImageReady,
}: MediaImageCropperProps) {
	const { t } = useLingui();
	const instructionsId = React.useId();
	const cropperFrameRef = React.useRef<HTMLDivElement>(null);
	const [sourceAspect, setSourceAspect] = React.useState(1);
	const [renderedMediaSize, setRenderedMediaSize] = React.useState<Size | null>(null);
	const [resizeAnnouncement, setResizeAnnouncement] = React.useState("");
	const aspect = aspectProp ?? sourceAspect;
	const handleMediaLoaded = (media: MediaSize) => {
		if (media.naturalWidth > 0 && media.naturalHeight > 0) {
			setSourceAspect(media.naturalWidth / media.naturalHeight);
			onSourceReady({ width: media.naturalWidth, height: media.naturalHeight });
		}
	};
	const handleRenderedMediaSize = React.useCallback((size: MediaSize) => {
		setRenderedMediaSize((current) =>
			current?.width === size.width && current.height === size.height
				? current
				: { width: size.width, height: size.height },
		);
	}, []);
	const getResizeBounds = React.useCallback((): Size => {
		const frame = cropperFrameRef.current;
		const frameWidth = frame?.clientWidth || Number.POSITIVE_INFINITY;
		const frameHeight = frame?.clientHeight || Number.POSITIVE_INFINITY;
		return {
			width: Math.max(1, Math.min(frameWidth, renderedMediaSize?.width ?? frameWidth)),
			height: Math.max(1, Math.min(frameHeight, renderedMediaSize?.height ?? frameHeight)),
		};
	}, [renderedMediaSize]);
	const announceCropSize = React.useCallback(
		(size: Size) => {
			setResizeAnnouncement(
				t`Crop area ${Math.round(size.width)} by ${Math.round(size.height)} pixels.`,
			);
		},
		[t],
	);
	React.useEffect(() => {
		if (!resizable || !cropSize || !onCropSizeChange || !renderedMediaSize) return;
		const constrainCropSize = () => {
			const bounds = getResizeBounds();
			const boundedSize = {
				width: Math.min(cropSize.width, bounds.width),
				height: Math.min(cropSize.height, bounds.height),
			};
			if (boundedSize.width !== cropSize.width || boundedSize.height !== cropSize.height) {
				onCropSizeChange(boundedSize);
			}
		};
		constrainCropSize();
		const frame = cropperFrameRef.current;
		if (!frame || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(constrainCropSize);
		observer.observe(frame);
		return () => observer.disconnect();
	}, [cropSize, getResizeBounds, onCropSizeChange, renderedMediaSize, resizable]);

	return (
		<div className="grid min-w-0 gap-4">
			<div
				ref={cropperFrameRef}
				className="emdash-image-cropper relative h-64 min-w-0 overflow-hidden rounded-xl bg-kumo-contrast ring ring-kumo-line sm:h-80"
			>
				<Cropper
					image={src}
					crop={crop}
					zoom={zoom}
					rotation={0}
					aspect={aspect}
					cropSize={cropSize}
					minZoom={1}
					maxZoom={3}
					cropShape="rect"
					objectFit="contain"
					showGrid
					zoomWithScroll
					roundCropAreaPixels
					keyboardStep={1}
					disableAutomaticStylesInjection
					classes={{ cropAreaClassName: "emdash-image-crop-area" }}
					cropperProps={{
						"aria-label": t`Crop image. Use arrow keys to move the crop area.`,
						"aria-describedby": instructionsId,
						"aria-disabled": disabled || undefined,
						tabIndex: disabled ? -1 : 0,
					}}
					mediaProps={{ alt: "", onError: onSourceError }}
					onCropChange={disabled ? () => undefined : onCropChange}
					onZoomChange={disabled ? undefined : onZoomChange}
					onCropSizeChange={onCropSizeChange}
					onCropComplete={(_area, pixels) =>
						onCropComplete({
							x: Math.round(pixels.x),
							y: Math.round(pixels.y),
							width: Math.round(pixels.width),
							height: Math.round(pixels.height),
						})
					}
					onMediaLoaded={handleMediaLoaded}
					setMediaSize={handleRenderedMediaSize}
					onTouchRequest={() => !disabled}
					onWheelRequest={() => !disabled}
					setImageRef={(ref) => onImageReady?.(ref.current)}
				/>
				{resizable && cropSize && onCropSizeChange ? (
					<>
						<CropResizeHandle
							edge="top"
							label={t`Resize crop from top edge`}
							cropSize={cropSize}
							disabled={disabled}
							getBounds={getResizeBounds}
							onResize={onCropSizeChange}
							onResizeEnd={announceCropSize}
						/>
						<CropResizeHandle
							edge="right"
							label={t`Resize crop from right edge`}
							cropSize={cropSize}
							disabled={disabled}
							getBounds={getResizeBounds}
							onResize={onCropSizeChange}
							onResizeEnd={announceCropSize}
						/>
						<CropResizeHandle
							edge="bottom"
							label={t`Resize crop from bottom edge`}
							cropSize={cropSize}
							disabled={disabled}
							getBounds={getResizeBounds}
							onResize={onCropSizeChange}
							onResizeEnd={announceCropSize}
						/>
						<CropResizeHandle
							edge="left"
							label={t`Resize crop from left edge`}
							cropSize={cropSize}
							disabled={disabled}
							getBounds={getResizeBounds}
							onResize={onCropSizeChange}
							onResizeEnd={announceCropSize}
						/>
					</>
				) : null}
			</div>

			<Slider.Root
				value={zoom}
				disabled={disabled}
				min={1}
				max={3}
				step={0.01}
				format={{ style: "percent", maximumFractionDigits: 0 }}
				className="grid gap-1.5"
				onValueChange={onZoomChange}
			>
				<div className="flex items-center justify-between gap-3 text-sm">
					<Slider.Label>{t`Zoom`}</Slider.Label>
					<Slider.Value className="tabular-nums text-kumo-subtle" />
				</div>
				<Slider.Control className="flex min-h-6 touch-none items-center">
					<Slider.Track className="relative h-1 w-full rounded-full bg-kumo-fill">
						<Slider.Indicator className="rounded-full bg-kumo-brand" />
						<Slider.Thumb
							className="size-4 rounded-full bg-kumo-brand ring-2 ring-kumo-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand"
							getAriaValueText={(_formattedValue, value) => t`${Math.round(value * 100)}%`}
						/>
					</Slider.Track>
				</Slider.Control>
			</Slider.Root>

			<p id={instructionsId} className="text-sm text-kumo-subtle">
				{resizable
					? t`Drag the image to position it. Drag a crop edge, or focus its handle and use the Arrow keys, to resize.`
					: t`Drag the image or use the Arrow keys to position the crop.`}
			</p>
			<p className="sr-only" role="status">
				{resizeAnnouncement}
			</p>
		</div>
	);
}
