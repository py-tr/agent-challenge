import { DecisionHistory } from "./DecisionHistory";
import type { DecisionsResponse } from "../api/pulseApi";

interface Props {
  data: DecisionsResponse | null;
  loading: boolean;
}

export function HistoryView({ data, loading }: Props) {
  return <DecisionHistory data={data} loading={loading} />;
}
