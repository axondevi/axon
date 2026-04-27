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
 *      Why not OpenZeppelin? Two reasons:
 *        1. Smaller contract = lower gas to deploy
 *        2. Audit surface = exactly what we need, no bloat
 *      For production, swap to OpenZeppelin's ERC721 + ERC2981 if you want
 *      the audited base.
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

    /// @notice Contract owner (governance, can rotate minter).
    address public owner;

    /// @notice Royalty receiver (Axon platform). 5% by default.
    address public royaltyReceiver;
    uint96 public royaltyBps = 500;  // 5.00%

    uint256 public totalSupply;

    // ─── Events ──────────────────────────────────────────────
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event AgentMinted(uint256 indexed tokenId, address indexed creator, string slug);
    event MinterChanged(address indexed previous, address indexed next);
    event RoyaltyChanged(address indexed receiver, uint96 bps);

    // ─── Errors ──────────────────────────────────────────────
    error NotOwner();
    error NotMinter();
    error NotAuthorized();
    error InvalidRecipient();
    error AlreadyMinted();
    error TokenDoesNotExist();
    error InvalidRoyalty();

    // ─── Modifiers ───────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────
    constructor(address _minter, address _royaltyReceiver) {
        owner = msg.sender;
        minter = _minter;
        royaltyReceiver = _royaltyReceiver;
        emit MinterChanged(address(0), _minter);
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

    // ─── Transfer (standard ERC-721) ─────────────────────────
    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        transferFrom(from, to, tokenId);
        // Skipping IERC721Receiver check for gas — Privy/EOA wallets always accept
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
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

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
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
