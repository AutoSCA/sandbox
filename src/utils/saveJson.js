import fs from 'fs/promises';
import path from 'path';

export async function saveJson(jsonData, savePath) {
    try {
        const dir = path.dirname(savePath);
        await fs.mkdir(dir, { recursive: true });

        const jsonString = JSON.stringify(jsonData, null, 2);
        await fs.writeFile(savePath, jsonString, 'utf-8');

        return {
            result: true,
            data: null
        };
    }
    catch (error) {
        return {
            result: false,
            data: error.message
        };
    }
}
