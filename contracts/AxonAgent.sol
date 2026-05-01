// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AxonAgent — NFT representing ownership of an AI agent on Axon.
 * @notice Each NFT corresponds to one agent in the Axon platform. The NFT
 *         is the canonical proof of ownership: whoever holds it owns the
 *         agent. Transfers move ownership — including future royalties from
 *         the agent's usage.
 *
 *         Designed to be CAMOUFLAGED: end-users never need to interact with
 *         this contract directly. The Axon backend mints/transfers on their
 *         behalf using a paymaster (account abstraction). Users see "I own
 *         my agent" — they don't see "I have an NFT".
 *
 * @dev Minimal ERC-721 + EIP-2981 royalty implementation. Built for Base.
 *
 *      Hardening over the v0 minimal version:
 *        1. safeTransferFrom now actually checks IERC721Receiver — required
 *           by ERC-721 spec; vault/multisig wrappers depend on it. The
 *           "Privy/EOA always accepts" comment was wrong: Safe contract
 *           wallets, Argent, and Coinbase Smart Wallet are all contracts.
 *        2. Pausable: an authorized pauser can stop mint+transfer if a
 *           critical bug is found before mainnet rollback.
 *        3. ReentrancyGuard on the only state-mutating call that calls back
 *           into a third party (safeTransferFrom → onERC721Received).
 *        4. Two-step ownership transfer: setOwner picks a pending owner,
 *           acceptOwnership claims it. Prevents accidental transfer to a
 *           wrong address (single-step setOwner could brick the contract).
 *        5. tokenURI is settable post-mint by `minter` only. The original
 *           used `tokenURI[tokenId] = uri` at mint with no update path —
 *           if the metadata host moved, every NFT broke.
 *
 *      Why not import OpenZeppelin: this codebase compiles with raw solc,
 *      no Foundry/Hardhat. Inlined the small bits we need rather than
 *      pulling node_modules into a Solidity build. Audited as a single
 *      file.
 */
contract AxonAgent {
    // ─── ERC-721 storage ─────────────────────────────────────
    string public constant name = "Axon Agent";
    string public constant symbol = "AXNA";

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    /// @notice Token URI returns IPFS or HTTPS pointer to metadata JSON.
    mapping(uint256 => string) public tokenURI;

    /// @notice Original creator, for royalty + provenance.
    mapping(uint256 => address) public creatorOf;

    // ─── Authorization ───────────────────────────────────────
    /// @notice The Axon backend address allowed to mint/transfer on user's
    ///         behalf. This is the "paymaster" / "operator" pattern.
    address public minter;

    /// @notice Contract owner (governance, can rotate minter, set royalty).
    address public owner;
    /// @notice Two-step ownership transfer staging slot.
    address public pendingOwner;

    /// @notice Pauser address — separate role from `owner` so a multisig
    /// can keep upgrade rights while granting kill-switch to incident response.
    address public pauser;

    /// @notice Royalty receiver (Axon platform). 5% by default.
    address public royaltyReceiver;
    uint96 public royaltyBps = 500;  // 5.00%

    uint256 public totalSupply;

    /// @notice When true, mint and transfer revert. Read/view paths still work.
    bool public paused;

    /// @notice Reentrancy guard.
    uint256 private _reentrant;

    // ─── Events ──────────────────────────────────────────────
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event AgentMinted(uint256 indexed tokenId, address indexed creator, string slug);
    event MinterChanged(address indexed previous, address indexed next);
    event PauserChanged(address indexed previous, address indexed next);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event OwnershipTransferStarted(address indexed previous, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previous, address indexed next);
    event RoyaltyChanged(address indexed receiver, uint96 bps);
    event TokenURIUpdated(uint256 indexed tokenId, string uri);

    // ─── Errors ──────────────────────────────────────────────
    error NotOwner();
    error NotPendingOwner();
    error NotMinter();
    error NotPauser();
    error NotAuthorized();
    error InvalidRecipient();
    error AlreadyMinted();
    error TokenDoesNotExist();
    error InvalidRoyalty();
    error PausedError();
    error Reentrant();
    error UnsafeRecipient();

    // ─── Modifiers ───────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }

    modifier onlyPauser() {
        if (msg.sender != pauser && msg.sender != owner) revert NotPauser();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    modifier nonReentrant() {
        if (_reentrant == 1) revert Reentrant();
        _reentrant = 1;
        _;
        _reentrant = 0;
    }

    // ─── Constructor ─────────────────────────────────────────
    constructor(address _minter, address _royaltyReceiver) {
        owner = msg.sender;
        pauser = msg.sender;
        minter = _minter;
        royaltyReceiver = _royaltyReceiver;
        emit MinterChanged(address(0), _minter);
        emit PauserChanged(address(0), msg.sender);
        emit RoyaltyChanged(_royaltyReceiver, royaltyBps);
    }

    // ─── Mint (only Axon backend can call) ───────────────────
    /**
     * @notice Mint a new agent NFT. Called by the Axon backend after a user
     *         publishes a new agent. The user's embedded wallet receives it.
     * @param to The user's wallet address (Privy embedded or external).
     * @param tokenId Unique ID for this agent (derived from Axon DB UUID).
     * @param uri IPFS or HTTPS URI to agent metadata JSON.
     * @param slug Human-readable agent slug (for events/indexing).
     */
    function mint(address to, uint256 tokenId, string calldata uri, string calldata slug)
        external
        onlyMinter
        whenNotPaused
    {
        if (to == address(0)) revert InvalidRecipient();
        if (ownerOf[tokenId] != address(0)) revert AlreadyMinted();

        ownerOf[tokenId] = to;
        balanceOf[to] += 1;
        tokenURI[tokenId] = uri;
        creatorOf[tokenId] = to;
        totalSupply += 1;

        emit Transfer(address(0), to, tokenId);
        emit AgentMinted(tokenId, to, slug);
    }

    /// @notice Update the metadata URI of an existing token. Useful when the
    /// metadata host moves (e.g. IPFS pin churn). Only the minter (the
    /// platform) can call — owners can't tamper with provenance.
    function setTokenURI(uint256 tokenId, string calldata uri) external onlyMinter {
        if (ownerOf[tokenId] == address(0)) revert TokenDoesNotExist();
        tokenURI[tokenId] = uri;
        emit TokenURIUpdated(tokenId, uri);
    }

    // ─── Transfer (standard ERC-721) ─────────────────────────
    function safeTransferFrom(address from, address to, uint256 tokenId) external nonReentrant whenNotPaused {
        _safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data)
        external
        nonReentrant
        whenNotPaused
    {
        _safeTransferFrom(from, to, tokenId, data);
    }

    function _safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) internal {
        _transferFrom(from, to, tokenId);
        // ERC-721 spec: if `to` is a contract, it MUST implement
        // IERC721Receiver.onERC721Received and return the magic value.
        // The previous version skipped this for gas — incorrect, since
        // Safe / Argent / Coinbase Smart Wallet are all contracts and a
        // marketplace using safeTransferFrom would silently lock NFTs.
        if (to.code.length > 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 ret) {
                if (ret != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
            } catch {
                revert UnsafeRecipient();
            }
        }
    }

    function transferFrom(address from, address to, uint256 tokenId) external whenNotPaused {
        _transferFrom(from, to, tokenId);
    }

    function _transferFrom(address from, address to, uint256 tokenId) internal {
        if (to == address(0)) revert InvalidRecipient();
        address prev = ownerOf[tokenId];
        if (prev == address(0)) revert TokenDoesNotExist();
        if (prev != from) revert NotAuthorized();
        if (
            msg.sender != from &&
            msg.sender != getApproved[tokenId] &&
            !isApprovedForAll[from][msg.sender] &&
            msg.sender != minter  // Axon backend can transfer on user's behalf
        ) {
            revert NotAuthorized();
        }
        ownerOf[tokenId] = to;
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        delete getApproved[tokenId];
        emit Transfer(from, to, tokenId);
    }

    function approve(address to, uint256 tokenId) external {
        address tokenOwner = ownerOf[tokenId];
        if (msg.sender != tokenOwner && !isApprovedForAll[tokenOwner][msg.sender]) {
            revert NotAuthorized();
        }
        getApproved[tokenId] = to;
        emit Approval(tokenOwner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    // ─── EIP-2981 Royalty Standard ───────────────────────────
    /**
     * @notice Returns royalty info for marketplaces (OpenSea, Blur, Rodeo).
     *         5% of any secondary sale goes to Axon platform.
     */
    function royaltyInfo(uint256, uint256 salePrice)
        external
        view
        returns (address receiver, uint256 royaltyAmount)
    {
        return (royaltyReceiver, (salePrice * royaltyBps) / 10000);
    }

    // ─── Pause ───────────────────────────────────────────────
    function pause() external onlyPauser {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyPauser {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setPauser(address newPauser) external onlyOwner {
        emit PauserChanged(pauser, newPauser);
        pauser = newPauser;
    }

    // ─── Admin ────────────────────────────────────────────────
    function setMinter(address newMinter) external onlyOwner {
        emit MinterChanged(minter, newMinter);
        minter = newMinter;
    }

    function setRoyalty(address receiver, uint96 bps) external onlyOwner {
        if (bps > 1000) revert InvalidRoyalty();  // max 10%
        royaltyReceiver = receiver;
        royaltyBps = bps;
        emit RoyaltyChanged(receiver, bps);
    }

    /// @notice Stage a new owner. Two-step: must call acceptOwnership() from
    /// the new address to actually transfer. Single-step transfers historically
    /// brick contracts when the operator types the wrong address.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Accept the staged ownership transfer. Caller must equal pendingOwner.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address prev = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, owner);
    }

    /// @notice Renounce ownership — irreversibly disable governance. Use with
    /// extreme care; once renounced, royalty changes / minter rotation /
    /// pause are forever frozen.
    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
        pendingOwner = address(0);
    }

    // ─── EIP-165 Interface Detection ─────────────────────────
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 ||  // ERC-165
            interfaceId == 0x80ac58cd ||  // ERC-721
            interfaceId == 0x5b5e139f ||  // ERC-721 Metadata
            interfaceId == 0x2a55205a;    // EIP-2981 Royalty
    }
}

/// @notice Minimal IERC721Receiver inlined to avoid an import.
interface IERC721Receiver {
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4);
}
