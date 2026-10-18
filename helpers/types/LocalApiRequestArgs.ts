export interface LocalApiRequestArgs {
    url: string;
    method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';
    body?: string;
}

export default LocalApiRequestArgs;
