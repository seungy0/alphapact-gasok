interface Env { COPY_ENGINE: Fetcher }

export const onRequest: PagesFunction<Env> = ({ request, env }) => env.COPY_ENGINE.fetch(request);
