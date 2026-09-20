export interface LocalApiRequestArgs {
    url: string;
    method: 'get' | 'post' | 'put' | 'options';
    body?: string;
}

export default LocalApiRequestArgs;
