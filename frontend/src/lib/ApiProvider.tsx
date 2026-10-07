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
import { ApiError, HttpApiClient, type ApiClient, type AuthBridge } from "./api.js";
import type { RuntimeConfig } from "./config.js";
import { MockApiClient } from "../mock/mockApi.js";

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({
  config,
  auth,
  children,
  client,
}: {
  config: RuntimeConfig;
  /**
   * 인증 브릿지 — 실서비스 HttpApiClient가 세션 만료를 스스로 다루게 한다.
   * ensureFreshToken(선제 갱신)·onUnauthorized(401 시 갱신/로그아웃)를 AuthContext가 준다.
   */
  auth: AuthBridge;
  children: ReactNode;
  client?: ApiClient; // 테스트 주입용
}): JSX.Element {
  // auth 함수는 세션 변화에 따라 정체성이 바뀔 수 있으나, 클라이언트가 항상 최신을
  // 호출하도록 안정적인 래퍼(ref)로 감싼다 → config만으로 클라이언트를 재생성.
  const authRef = useRef(auth);
  authRef.current = auth;

  const api = useMemo<ApiClient>(() => {
    if (client) return client;
    if (config.mock) return new MockApiClient();
    const bridge: AuthBridge = {
      ensureFreshToken: () => authRef.current.ensureFreshToken(),
      onUnauthorized: () => authRef.current.onUnauthorized(),
    };
    return new HttpApiClient(config.apiUrl, bridge);
  }, [config, client]);
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
  /** 화면 쪽 낙관적 갱신용 — 서버 왕복 없이 data 를 바꾼다(다음 재요청 결과가 덮어씀). */
  mutate: (updater: (prev: T | null) => T | null) => void;
}

export interface QueryOptions<T> {
  /**
   * 자동 재요청 주기(ms). false/0/미지정이면 자동 재요청 없음.
   * 함수면 최신 data 로 매 렌더 계산한다(예: 전이 상태면 5초, 아니면 30초).
   * - 직전 요청이 끝난 뒤부터 주기를 센다(요청이 겹치지 않음).
   * - 자동 재요청은 loading 을 켜지 않는다(스켈레톤 깜빡임 없이 조용히 갱신).
   * - 탭이 숨겨지면(visibilitychange) 멈추고, 다시 보이면 즉시 한 번 불러온 뒤 주기를 이어간다.
   * - 조용한 재요청이 실패하면 기존 data 를 유지한다(일시 오류로 화면을 비우지 않음).
   *   단 404 는 "대상이 사라짐"이므로 data 를 비우고 error 로 알린다(예: 삭제 완료된 앱).
   */
  refetchInterval?: number | false | ((data: T | null) => number | false);
}

function isDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** 단순 데이터 패칭 훅. deps 변경 또는 reload 시 재요청. opts.refetchInterval 로 주기 갱신. */
export function useQuery<T>(
  fetcher: (api: ApiClient) => Promise<T>,
  deps: unknown[],
  opts: QueryOptions<T> = {},
): QueryResult<T> {
  const api = useApi();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);
  // 요청(최초·reload·자동)이 끝날 때마다 증가 — 다음 자동 재요청 예약의 기준점.
  const [settled, setSettled] = useState(0);
  const [visible, setVisible] = useState(isDocumentVisible);
  // 숨김→보임 전환 직후에는 주기를 기다리지 않고 바로 불러온다.
  const resumeRef = useRef(false);
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
        if (!cancelled) {
          setLoading(false);
          setSettled((n) => n + 1);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, tick, ...deps]);

  const ri = opts.refetchInterval;
  const interval = (typeof ri === "function" ? ri(data) : ri) || 0;

  useEffect(() => {
    if (!interval) return;
    const onVis = (): void => {
      const v = isDocumentVisible();
      if (v) resumeRef.current = true;
      setVisible(v);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [interval]);

  useEffect(() => {
    if (!interval || !visible || loading) return;
    let cancelled = false;
    const wait = resumeRef.current ? 0 : interval;
    resumeRef.current = false;
    const timer = window.setTimeout(() => {
      fetcherRef
        .current(api)
        .then((d) => {
          if (cancelled) return;
          setData(d);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          if (e instanceof ApiError && e.httpStatus === 404) {
            setData(null);
            setError(e);
          }
          // 그 외 일시 오류는 조용히 넘기고 다음 주기에 다시 시도한다.
        })
        .finally(() => {
          if (!cancelled) setSettled((n) => n + 1);
        });
    }, wait);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, interval, visible, loading, settled, ...deps]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const mutate = useCallback((updater: (prev: T | null) => T | null) => setData(updater), []);
  return { data, loading, error, reload, mutate };
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
