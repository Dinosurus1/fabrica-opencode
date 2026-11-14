import { useQuery } from "@tanstack/react-query";
import { rpc } from "./rpc";
import type { Health } from "./types";

export function useFactoryHealth(directory?: string) {
  return useQuery({
    queryKey: ["factory", "health", directory ?? "default"],
    queryFn: () => rpc<Health>("health", {}, directory),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
