"""In-memory SBF test runner. No RPC client, sockets, wallet files or exported keys.
Requires solders==0.29.0 in an explicitly supplied isolated Python path.
Only public, deliberately synthetic test-domain signers are usable here.
"""
import base64
import hashlib
import json
import sys
from pathlib import Path
import solders
from solders.account import Account
from solders.clock import Clock
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.message import from_bytes_versioned, to_bytes_versioned
from solders.transaction import VersionedTransaction
from solders.transaction_metadata import FailedTransactionMetadata
from solders.litesvm import LiteSVM

assert solders.__version__ == '0.29.0'
DOMAIN = 'repo.ing atomic canary isolated SVM tests v1 '
roles = {role: Keypair.from_seed(hashlib.sha256((DOMAIN + role).encode()).digest())
         for role in ['creator', 'admin', 'upgrade', 'guardian', 'treasury', 'mint', 'config', 'outsider', 'table']}
by_address = {str(k.pubkey()): k for k in roles.values()}
svm = LiteSVM().with_sigverify(True).with_blockhash_check(True).with_log_bytes_limit(10000)
svm.set_clock(Clock(100, 0, 0, 0, 1800000000))

def account_row(address):
    account = svm.get_account(Pubkey.from_string(address))
    return {'address': address, 'account': None if account is None else {
        'address': address, 'owner': str(account.owner), 'executable': account.executable,
        'lamports': str(account.lamports), 'dataBase64': base64.b64encode(account.data).decode()}}

def process(request):
    operation = request['op']
    if operation == 'init':
        assert request['scope'] == 'isolated-canary-svm/1'
        for program in request['programs']:
            data = Path(program['path']).read_bytes()
            assert hashlib.sha256(data).hexdigest() == program['sha256']
            try:
                svm.add_program(Pubkey.from_string(program['address']), data)
            except Exception as error:
                raise RuntimeError(f"ELF load at {program['address']}: {error}") from error
        return {'blockhash': str(svm.latest_blockhash()), 'slot': svm.get_clock().slot,
                'roles': {role: str(k.pubkey()) for role, k in roles.items()}}
    if operation == 'set':
        for row in request['accounts']:
            value = row['account']
            assert value is not None
            try:
                svm.set_account(Pubkey.from_string(row['address']), Account(
                    int(value['lamports']), base64.b64decode(value['dataBase64']),
                    Pubkey.from_string(value['owner']), value['executable'], 0))
            except Exception as error:
                raise RuntimeError(f"Synthetic setup at {row['address']}: {error}") from error
        return {'set': len(request['accounts'])}
    if operation == 'get':
        return {'accounts': [account_row(address) for address in request['addresses']],
                'blockhash': str(svm.latest_blockhash()), 'slot': svm.get_clock().slot}
    if operation == 'expire':
        svm.expire_blockhash()
        return {'blockhash': str(svm.latest_blockhash())}
    if operation in ('sign', 'send'):
        message = from_bytes_versioned(base64.b64decode(request['messageBase64']))
        signers = list(message.account_keys[:message.header.num_required_signatures])
        assert all(str(address) in by_address for address in signers), 'Non-synthetic signer forbidden'
        missing = set(request.get('missing', []))
        wire_message = to_bytes_versioned(message)
        signatures = [Signature.default() if str(address) in missing else by_address[str(address)].sign_message(wire_message)
                      for address in signers]
        tx = VersionedTransaction.populate(message, signatures)
        wire = bytes(tx)
        assert len(wire) <= 1232, 'Solana packet limit exceeded'
        envelope = {'wireBytes': len(wire), 'wireBase64': base64.b64encode(wire).decode(),
                    'signature': str(signatures[0])}
        if operation == 'sign':
            return {**envelope, 'historyPresent': svm.get_transaction(signatures[0]) is not None}
        loaded = {'writable': [], 'readonly': []}
        for lookup in message.address_table_lookups:
            table = svm.get_account(lookup.account_key)
            assert table is not None
            for category, indexes in [('writable', lookup.writable_indexes), ('readonly', lookup.readonly_indexes)]:
                for index in indexes:
                    value = table.data[56 + index * 32:88 + index * 32]
                    assert len(value) == 32
                    loaded[category].append(Pubkey.from_bytes(value))
        keys = list(message.account_keys) + loaded['writable'] + loaded['readonly']
        pre = [svm.get_balance(address) or 0 for address in keys]
        result = svm.send_transaction(tx)
        failure = isinstance(result, FailedTransactionMetadata)
        meta = result.meta() if failure else result
        inner = []
        for index, group in enumerate(meta.inner_instructions()):
            rows = []
            for entry in group:
                instruction = entry.instruction()
                rows.append({'programIdIndex': instruction.program_id_index,
                             'accounts': list(instruction.accounts),
                             'dataBase64': base64.b64encode(instruction.data).decode(),
                             'stackHeight': json.loads(entry.to_json())['stackHeight']})
            if rows:
                inner.append({'index': index, 'instructions': rows})
        post = [svm.get_balance(address) or 0 for address in keys]
        return {**envelope, 'error': str(result.err()) if failure else None, 'logs': meta.logs(),
                'units': meta.compute_units_consumed(), 'innerInstructions': inner,
                'slot': svm.get_clock().slot, 'keys': [str(address) for address in keys],
                'loadedAddresses': {kind: [str(address) for address in values] for kind, values in loaded.items()},
                'preBalances': pre, 'postBalances': post, 'fee': sum(pre) - sum(post),
                'historyPresent': svm.get_transaction(signatures[0]) is not None}
    raise ValueError('Unknown in-memory operation')

for line in sys.stdin:
    try:
        print(json.dumps(process(json.loads(line))), flush=True)
    except Exception as error:
        # Never render signer objects, raw requests or private material.
        print(json.dumps({'runnerError': type(error).__name__, 'message': str(error)}), flush=True)
