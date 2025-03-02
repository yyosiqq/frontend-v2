<script setup lang="ts">
import {
  TransactionReceipt,
  TransactionResponse,
} from '@ethersproject/abstract-provider';
import { format } from 'date-fns';
import { computed, onBeforeMount, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import { PRETTY_DATE_FORMAT } from '@/components/forms/lock_actions/constants';
import { LockType } from '@/components/forms/lock_actions/LockForm/types';
import useConfig from '@/composables/useConfig';
import useEthers from '@/composables/useEthers';
import useNumbers, { FNumFormats } from '@/composables/useNumbers';
import { dateTimeLabelFor } from '@/composables/useTime';
import useTransactions from '@/composables/useTransactions';
import useNetwork from '@/composables/useNetwork';
import { balancerContractsService } from '@/services/balancer/contracts/balancer-contracts.service';
import useWeb3 from '@/services/web3/useWeb3';
import { TokenInfo } from '@/types/TokenList';
import { TransactionActionInfo } from '@/types/transactions';
import useVotingGauges from '@/composables/useVotingGauges';
import { VeBalLockInfo } from '@/services/balancer/contracts/contracts/veBAL';
import { ApprovalAction } from '@/composables/approvals/types';
import useTokenApprovalActions from '@/composables/approvals/useTokenApprovalActions';
import { captureBalancerException } from '@/lib/utils/errors';
import { useCrossChainSync } from '@/providers/cross-chain-sync.provider';

/**
 * TYPES
 */
type Props = {
  lockablePoolTokenInfo: TokenInfo;
  lockAmount: string;
  lockEndDate: string;
  lockType: LockType[];
  lockConfirmed: boolean;
  veBalLockInfo: VeBalLockInfo;
};

type LockActionState = {
  init: boolean;
  confirming: boolean;
  confirmed: boolean;
  confirmedAt: string;
  receipt?: TransactionReceipt;
};

/**
 * PROPS & EMITS
 */
const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'success', value: LockActionState[]): void;
}>();

/**
 * STATE
 */
const isLoadingApprovals = ref(true);
const lockActionStates = reactive<LockActionState[]>(
  props.lockType.map(() => ({
    init: false,
    confirming: false,
    confirmed: false,
    confirmedAt: '',
  }))
);

/**
 * COMPOSABLES
 */
const { t } = useI18n();
const { networkConfig } = useConfig();
const { getProvider, explorerLinks, isMismatchedNetwork } = useWeb3();
const { addTransaction } = useTransactions();
const { txListener, getTxConfirmedAt } = useEthers();
const { fNum } = useNumbers();
const { totalVotes, unallocatedVotes } = useVotingGauges();
const { networkSlug } = useNetwork();
const { getTokenApprovalActions } = useTokenApprovalActions();
const { refetch: refetchSyncData } = useCrossChainSync();

const lockActions = props.lockType.map((lockType, actionIndex) => ({
  label: t(`getVeBAL.previewModal.actions.${lockType}.label`, [
    format(new Date(props.lockEndDate), PRETTY_DATE_FORMAT),
  ]),
  loadingLabel: t(`getVeBAL.previewModal.actions.${lockType}.loadingLabel`),
  confirmingLabel: t(`getVeBAL.previewModal.actions.${lockType}.confirming`),
  action: () => submit(lockType, actionIndex),
  stepTooltip: t(`getVeBAL.previewModal.actions.${lockType}.tooltip`),
}));

const actions = ref<TransactionActionInfo[]>([...lockActions]);

/**
 * COMPUTED
 */
const lockActionStatesConfirmed = computed(() =>
  lockActionStates.every(lockActionState => lockActionState.confirmed)
);

const shouldResubmitVotes = computed<boolean>(
  () => totalVotes !== unallocatedVotes.value
);

const amountsToApprove = computed(() => [
  {
    address: props.lockablePoolTokenInfo.address,
    amount: props.lockAmount,
  },
]);

/**
 * METHODS
 */
async function handleTransaction(
  tx: TransactionResponse,
  lockType: LockType,
  actionIndex: number
): Promise<void> {
  addTransaction({
    id: tx.hash,
    type: 'tx',
    action: lockType,
    summary:
      lockType === LockType.EXTEND_LOCK
        ? t('transactionSummary.extendLock', [
            format(new Date(props.lockEndDate), PRETTY_DATE_FORMAT),
          ])
        : `${fNum(props.lockAmount, FNumFormats.token)} ${
            props.lockablePoolTokenInfo.symbol
          }`,
    details: {
      lockAmount: props.lockAmount,
      lockEndDate: props.lockEndDate,
      lockType,
    },
  });

  lockActionStates[actionIndex].confirmed = await txListener(tx, {
    onTxConfirmed: async (receipt: TransactionReceipt) => {
      lockActionStates[actionIndex].confirming = false;
      lockActionStates[actionIndex].receipt = receipt;

      const confirmedAt = await getTxConfirmedAt(receipt);
      lockActionStates[actionIndex].confirmedAt = dateTimeLabelFor(confirmedAt);

      refetchSyncData();
    },
    onTxFailed: () => {
      lockActionStates[actionIndex].confirming = false;
    },
  });
}

async function submit(lockType: LockType, actionIndex: number) {
  try {
    let tx: TransactionResponse;
    lockActionStates[actionIndex].init = true;

    if (lockType === LockType.CREATE_LOCK) {
      tx = await balancerContractsService.veBAL.createLock(
        getProvider(),
        props.lockAmount,
        props.lockEndDate
      );
    } else if (lockType === LockType.EXTEND_LOCK) {
      tx = await balancerContractsService.veBAL.extendLock(
        getProvider(),
        props.lockEndDate
      );
    } else if (lockType === LockType.INCREASE_LOCK) {
      tx = await balancerContractsService.veBAL.increaseLock(
        getProvider(),
        props.lockAmount
      );
    } else {
      throw new Error('Unsupported lockType provided');
    }

    lockActionStates[actionIndex].init = false;
    lockActionStates[actionIndex].confirming = true;

    console.log('Receipt', tx);

    handleTransaction(tx, lockType, actionIndex);
    return tx;
  } catch (error) {
    // An exception is already logged in balancerContractsService, but we should
    // log another here in case any exceptions are thrown before it's sent
    captureBalancerException({
      error,
      context: { level: 'fatal', extra: { lockType, props } },
    });

    return Promise.reject(error);
  }
}

/**
 * WATCHERS
 */
watch(lockActionStatesConfirmed, () => {
  if (lockActionStatesConfirmed.value) {
    emit('success', lockActionStates);
  }
});

/**
 * LIFECYCLE
 */
onBeforeMount(async () => {
  const approvalActions = await getTokenApprovalActions({
    amountsToApprove: amountsToApprove.value,
    spender: networkConfig.addresses.veBAL,
    actionType: ApprovalAction.Locking,
  });
  actions.value.unshift(...approvalActions);
  isLoadingApprovals.value = false;
});
</script>

<template>
  <div>
    <BalActionSteps
      v-if="!lockActionStatesConfirmed"
      :actions="actions"
      :isLoading="isLoadingApprovals"
      :disabled="isMismatchedNetwork"
      primaryActionType="extendLock"
    />
    <template v-else>
      <div
        v-for="(lockActionState, i) in lockActionStates"
        :key="i"
        class="flex justify-between items-center mt-4 text-sm text-gray-400 dark:text-gray-600"
      >
        <div class="flex items-center">
          <BalIcon name="clock" />
          <span class="ml-2">
            {{ lockActionState.confirmedAt }}
          </span>
        </div>
        <BalLink
          v-if="lockActionState.receipt"
          :href="explorerLinks.txLink(lockActionState.receipt.transactionHash)"
          external
          noStyle
          class="group flex items-center"
        >
          {{ networkConfig.explorerName }}
          <BalIcon
            name="arrow-up-right"
            size="sm"
            class="ml-px group-hover:text-pink-500 transition-colors"
          />
        </BalLink>
      </div>
      <BalAlert
        v-if="lockConfirmed && !veBalLockInfo.hasExistingLock"
        class="mt-4"
        type="tip"
        :title="t('getVeBAL.previewModal.firstVeBALReceived.title')"
        :description="t('getVeBAL.previewModal.firstVeBALReceived.description')"
      >
      </BalAlert>
      <BalAlert
        v-else-if="shouldResubmitVotes"
        class="mt-4"
        type="warning"
        :title="t('veBAL.liquidityMining.resubmit.hint.title')"
        :description="t('veBAL.liquidityMining.resubmit.hint.description')"
      >
      </BalAlert>
      <BalBtn
        tag="router-link"
        :to="{ name: 'vebal', params: { networkSlug } }"
        color="gray"
        outline
        block
        class="mt-4"
      >
        {{ $t('getVeBAL.previewModal.returnToVeBalPage') }}
      </BalBtn>
    </template>
  </div>
</template>
