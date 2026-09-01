import { Slider } from "@cloudflare/kumo/primitives/slider";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";
import Cropper, { type MediaSize, type Point } from "react-easy-crop";

import type { PixelCrop } from "../lib/crop-image.js";

export interface MediaImageCropperProps {
	src: string;
	crop: Point;
	zoom: number;
	disabled?: boolean;
	onCropChange: (crop: Point) => void;
	onZoomChange: (zoom: number) => void;
	onCropComplete: (crop: PixelCrop) => void;
	onSourceReady: (size: { width: number; height: number }) => void;
	onSourceError: () => void;
	onImageReady?: (image: HTMLImageElement | null) => void;
}

export function MediaImageCropper({
	src,
	crop,
	zoom,
	disabled = false,
	onCropChange,
	onZoomChange,
	onCropComplete,
	onSourceReady,
	onSourceError,
	onImageReady,
}: MediaImageCropperProps) {
	const { t } = useLingui();
	const instructionsId = React.useId();
	const [aspect, setAspect] = React.useState(1);
	const handleMediaLoaded = (media: MediaSize) => {
		if (media.naturalWidth > 0 && media.naturalHeight > 0) {
			setAspect(media.naturalWidth / media.naturalHeight);
			onSourceReady({ width: media.naturalWidth, height: media.naturalHeight });
		}
	};

	return (
		<div className="grid min-w-0 gap-4">
			<div className="emdash-image-cropper relative h-64 min-w-0 overflow-hidden rounded-xl bg-kumo-contrast ring ring-kumo-line sm:h-80">
				<Cropper
					image={src}
					crop={crop}
					zoom={zoom}
					rotation={0}
					aspect={aspect}
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
					onCropComplete={(_area, pixels) =>
						onCropComplete({
							x: Math.round(pixels.x),
							y: Math.round(pixels.y),
							width: Math.round(pixels.width),
							height: Math.round(pixels.height),
						})
					}
					onMediaLoaded={handleMediaLoaded}
					onTouchRequest={() => !disabled}
					onWheelRequest={() => !disabled}
					setImageRef={(ref) => onImageReady?.(ref.current)}
				/>
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
				{t`Drag the image or use the Arrow keys to position the crop.`}
			</p>
		</div>
	);
}
