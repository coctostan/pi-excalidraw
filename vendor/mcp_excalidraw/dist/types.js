// Excalidraw element types
export const EXCALIDRAW_ELEMENT_TYPES = {
    RECTANGLE: 'rectangle',
    ELLIPSE: 'ellipse',
    DIAMOND: 'diamond',
    ARROW: 'arrow',
    TEXT: 'text',
    FREEDRAW: 'freedraw',
    LINE: 'line',
    IMAGE: 'image'
};
// In-memory storage for Excalidraw elements
export const elements = new Map();
// In-memory storage for snapshots
export const snapshots = new Map();
export const files = new Map();
// Validation function for Excalidraw elements
export function validateElement(element) {
    const requiredFields = ['type', 'x', 'y'];
    const hasRequiredFields = requiredFields.every(field => field in element);
    if (!hasRequiredFields) {
        throw new Error(`Missing required fields: ${requiredFields.join(', ')}`);
    }
    if (!Object.values(EXCALIDRAW_ELEMENT_TYPES).includes(element.type)) {
        throw new Error(`Invalid element type: ${element.type}`);
    }
    return true;
}
// Helper function to generate unique IDs
export function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}
// Normalize fontFamily from string names to numeric values that Excalidraw expects
// Excalidraw uses: 1 = Virgil (handwritten), 2 = Helvetica (sans-serif), 3 = Cascadia (monospace)
// 5 = Excalifont, 6 = Nunito, 7 = Lilita One, 8 = Comic Shanns
export function normalizeFontFamily(fontFamily) {
    if (fontFamily === undefined)
        return undefined;
    if (typeof fontFamily === 'number')
        return fontFamily;
    const map = {
        'virgil': 1, 'hand': 1, 'handwritten': 1,
        'helvetica': 2, 'sans': 2, 'sans-serif': 2,
        'cascadia': 3, 'mono': 3, 'monospace': 3,
        'excalifont': 5,
        'nunito': 6,
        'lilita': 7, 'lilita one': 7,
        'comic shanns': 8, 'comic': 8,
        '1': 1, '2': 2, '3': 3, '5': 5, '6': 6, '7': 7, '8': 8,
    };
    return map[fontFamily.toLowerCase()];
}
//# sourceMappingURL=types.js.map