export interface PixelCrop {
	x: number;
	y: number;
	width: number;
	height: number;
}

const CROPPABLE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function isSafeCrop(crop: PixelCrop): boolean {
	return (
		Number.isSafeInteger(crop.x) &&
		crop.x >= 0 &&
		Number.isSafeInteger(crop.y) &&
		crop.y >= 0 &&
		Number.isSafeInteger(crop.width) &&
		crop.width > 0 &&
		Number.isSafeInteger(crop.height) &&
		crop.height > 0
	);
}

export function createCroppedImageFile(
	source: CanvasImageSource,
	crop: PixelCrop,
	filename: string,
	mimeType: string,
): Promise<File> {
	if (!CROPPABLE_MIME_TYPES.has(mimeType)) {
		return Promise.reject(new Error("Unsupported crop MIME type"));
	}
	if (!isSafeCrop(crop)) {
		return Promise.reject(new Error("Invalid crop rectangle"));
	}

	const canvas = document.createElement("canvas");
	canvas.width = crop.width;
	canvas.height = crop.height;
	const context = canvas.getContext("2d");
	if (!context) return Promise.reject(new Error("Canvas is unavailable"));
	context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);

	return new Promise((resolve, reject) => {
		const complete = (blob: Blob | null) => {
			if (!blob) {
				reject(new Error("Cropped image could not be encoded"));
				return;
			}
			if (blob.type !== mimeType) {
				reject(new Error("Cropped image MIME type changed during encoding"));
				return;
			}
			resolve(new File([blob], filename, { type: mimeType, lastModified: Date.now() }));
		};

		if (mimeType === "image/png") {
			canvas.toBlob(complete, mimeType);
			return;
		}
		canvas.toBlob(complete, mimeType, 0.92);
	});
}
