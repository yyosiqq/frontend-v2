import { useQuery, UseQueryOptions } from '@tanstack/vue-query';

import QUERY_KEYS from '@/constants/queryKeys';
import { subgraphRequest } from '@/lib/utils/subgraph';
import { configService } from '@/services/config/config.service';

/**
 * TYPES
 */

type PoolsGaugesQueryResponse = Record<'pools', PoolsGauges[]>;
export type PoolsGauges = {
  preferentialGauge: {
    id: string | null;
  };
  gauges: {
    id: string;
    relativeWeightCap: string;
  }[];
  address: string;
  id: string;
};

type QueryOptions = UseQueryOptions<PoolsGaugesQueryResponse>;

/**
 * Fetches all gauges for a given pool and specifies which gauge is the
 * preferential gauge.
 */
export default function usePoolsGaugesQuery(
  poolAddresses: Ref<string[] | undefined>,
  options: QueryOptions = {}
) {
  /**
   * QUERY KEY
   */
  const queryKey = reactive(QUERY_KEYS.Pools.Gauges(poolAddresses));

  /**
   * COMPUTED
   */
  const enabled = computed((): boolean => !!poolAddresses?.value?.length);

  const subgraphQuery = computed(() => ({
    __name: 'PoolGauges',
    pools: {
      __args: {
        where: {
          address_in: poolAddresses.value?.map(address =>
            address.toLowerCase()
          ),
        },
      },
      preferentialGauge: {
        id: true,
      },
      gauges: {
        id: true,
        relativeWeightCap: true,
      },
      address: true,
      id: true,
    },
  }));

  /**
   * QUERY FUNCTION
   */
  const queryFn = async () => {
    try {
      return await subgraphRequest<PoolsGaugesQueryResponse>({
        url: configService.network.subgraphs.gauge,
        query: subgraphQuery.value,
      });
    } catch (error) {
      console.error(
        `Failed to fetch pool gauge for pools: ${poolAddresses.value}`,
        {
          cause: error,
        }
      );
      throw error;
    }
  };

  /**
   * QUERY OPTIONS
   */
  const queryOptions = reactive({
    enabled,
    refetchOnWindowFocus: false,
    ...options,
  });

  return useQuery<PoolsGaugesQueryResponse>(
    queryKey,
    queryFn,
    queryOptions as QueryOptions
  );
}
