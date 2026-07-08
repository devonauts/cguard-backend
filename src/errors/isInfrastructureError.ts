/**
 * True when an error is an INFRASTRUCTURE / transport failure — DB pool
 * exhaustion, connection refused/timeout, "Too many connections", dropped
 * socket — rather than an application or authentication error.
 *
 * Used so token validation can return 503 (retryable, session preserved) instead
 * of 401 (which logs the user out) when the DB briefly can't be reached. A 401 on
 * a transient DB blip is what caused users to "keep getting logged out" whenever
 * the connection pool was exhausted.
 *
 * Deliberately scoped to CONNECTION/TRANSPORT failures only — a SequelizeDatabaseError
 * (bad SQL, constraint) is a real 500, not a 503.
 */
export default function isInfrastructureError(err: any): boolean {
  if (!err) return false;

  // Walk name/message/code plus Sequelize's wrapped `original`/`parent` mysql error.
  const seen = new Set<any>();
  const collect = (e: any): string[] => {
    if (!e || typeof e !== 'object' || seen.has(e)) return [];
    seen.add(e);
    const parts: string[] = [];
    for (const k of ['name', 'message', 'code', 'errno', 'sqlState']) {
      const v = (e as any)[k];
      if (v != null) parts.push(String(v));
    }
    for (const k of ['original', 'parent', 'cause']) {
      if ((e as any)[k]) parts.push(...collect((e as any)[k]));
    }
    return parts;
  };

  const hay = collect(err).join(' ').toLowerCase();

  return (
    hay.includes('sequelizeconnection') ||          // SequelizeConnection*Error family (incl. acquire-timeout)
    hay.includes('hostnotreachable') ||
    hay.includes('too many connections') ||
    hay.includes('er_con_count_error') ||
    hay.includes('econnrefused') ||
    hay.includes('econnreset') ||
    hay.includes('etimedout') ||
    hay.includes('epipe') ||
    hay.includes('protocol_connection_lost') ||
    hay.includes('connection acquire') ||           // pool acquire timeout
    hay.includes('connection terminated') ||
    hay.includes('pool is draining') ||
    hay.includes('server closed the connection')
  );
}
