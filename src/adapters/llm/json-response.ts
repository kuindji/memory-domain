function parseJsonResponse<T>(text: string): T {
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : text;
    return JSON.parse(jsonStr) as T;
}

export { parseJsonResponse };
