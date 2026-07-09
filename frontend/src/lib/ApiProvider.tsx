/**
 * API 클라이언트 제공 컨텍스트 + 데이터 훅(useQuery/useMutation).
 * 목 모드면 MockApiClient, 실서비스면 HttpApiClient 를 주입한다.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, HttpApiClient, type ApiClient } from "./api.js";
import type { RuntimeConfig } from "./config.js";
import { MockApiClient } from "../mock/mockApi.js";

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({
  config,
  getToken,
  children,
  client,
}: {
  config: RuntimeConfig;
  getToken: () => string | null;
  children: ReactNode;
  client?: ApiClient; // 테스트 주입용
}): JSX.Element {
  const api = useMemo<ApiClient>(() => {
    if (client) return client;
    if (config.mock) return new MockApiClient();
    return new HttpApiClient(config.apiUrl, getToken);
  }, [config, getToken, client]);
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error("useApi는 ApiProvider 안에서만 사용할 수 있습니다.");
  return ctx;
}

export interface QueryResult<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  reload: () => void;
}

/** 단순 데이터 패칭 훅. deps 변경 또는 reload 시 재요청. */
export function useQuery<T>(
  fetcher: (api: ApiClient) => Promise<T>,
  deps: unknown[],
): QueryResult<T> {
  const api = useApi();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcherRef
      .current(api)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(
            e instanceof ApiError ? e : new ApiError("INTERNAL_ERROR", "요청을 처리하지 못했어요.", 0),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, tick, ...deps]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, reload };
}

export interface MutationState<A, R> {
  run: (args: A) => Promise<R>;
  loading: boolean;
  error: ApiError | null;
  reset: () => void;
}

export function useMutation<A, R>(
  action: (api: ApiClient, args: A) => Promise<R>,
): MutationState<A, R> {
  const api = useApi();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const actionRef = useRef(action);
  actionRef.current = action;

  const run = useCallback(
    async (args: A): Promise<R> => {
      setLoading(true);
      setError(null);
      try {
        return await actionRef.current(api, args);
      } catch (e) {
        const apiErr =
          e instanceof ApiError ? e : new ApiError("INTERNAL_ERROR", "요청을 처리하지 못했어요.", 0);
        setError(apiErr);
        throw apiErr;
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  const reset = useCallback(() => setError(null), []);
  return { run, loading, error, reset };
}
